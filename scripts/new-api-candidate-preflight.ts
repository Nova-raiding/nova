import { constants } from 'node:fs'
import { open, lstat, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

export interface SessionInspection {
  schema_version: '1'
  replica_id: string
  session_path: string
  runtime_uid: number
  directory_uid: number
  directory_dev: number
  directory_ino: number
  directory_mode: number
  session_uid: number
  session_mode: number
  expected_user_digest: string
  user_id_matches: boolean
  has_access_token: boolean
  has_refresh_cookie: boolean
}

/** Local metadata only. Neither the refresh cookie nor the access token is returned. */
export async function inspectNewApiSession(sessionFile: string, expectedUserId: string): Promise<SessionInspection> {
  if (!nonEmpty(sessionFile) || !nonEmpty(expectedUserId) || process.getuid?.() === undefined) throw new Error('NEW_API_PREFLIGHT_ARGUMENTS_INVALID')
  const sessionPath = resolve(sessionFile)
  const directory = dirname(sessionPath)
  const runtimeUid = process.getuid!()
  const parent = await lstat(directory)
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0 || parent.uid !== runtimeUid) throw new Error('NEW_API_PREFLIGHT_DIRECTORY_UNSAFE')
  const file = await open(sessionPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== runtimeUid) throw new Error('NEW_API_PREFLIGHT_FILE_UNSAFE')
    const data = record(JSON.parse(await file.readFile('utf8')))
    if (!data) throw new Error('NEW_API_PREFLIGHT_SESSION_INVALID')
    return {
      schema_version: '1', replica_id: hostname(), session_path: sessionPath, runtime_uid: runtimeUid,
      directory_uid: parent.uid, directory_dev: parent.dev, directory_ino: parent.ino,
      directory_mode: parent.mode & 0o777, session_uid: stat.uid, session_mode: stat.mode & 0o777,
      expected_user_digest: createHash('sha256').update(expectedUserId.trim()).digest('hex'),
      user_id_matches: String(data.userId ?? '') === expectedUserId.trim(),
      has_access_token: nonEmpty(data.userToken),
      has_refresh_cookie: typeof data.refreshCookie === 'string' && /^new_api_refresh=[^;\s]+$/u.test(data.refreshCookie),
    }
  } finally { await file.close() }
}

export interface CandidateKeyExpectation {
  id: number
  models: string[]
  maxRemainingQuota: number
  maxExpirySeconds: number
}

/** Accepts a management GET /api/token/:id response, but never returns its key field. */
export function validateCandidateKeyReadback(response: unknown, expected: CandidateKeyExpectation, nowSeconds: number): string[] {
  const errors: string[] = []
  const root = record(response)
  const data = record(root?.data)
  if (root?.success !== true || !data) return ['management token readback must be successful']
  if (data.id !== expected.id) errors.push('token id differs from requested candidate')
  if (data.status !== 1) errors.push('candidate token is not enabled')
  if (data.unlimited_quota !== false) errors.push('candidate token must have finite quota')
  if (data.model_limits_enabled !== true) errors.push('candidate token must enable model limits')
  const actualModels = Array.isArray(data.model_limits) ? data.model_limits : typeof data.model_limits === 'string' ? data.model_limits.split(',') : []
  const normalizedActual = actualModels.map(value => typeof value === 'string' ? value.trim() : '').filter(Boolean).sort()
  const normalizedExpected = expected.models.map(value => value.trim()).filter(Boolean).sort()
  if (!normalizedExpected.length || normalizedActual.length !== normalizedExpected.length || normalizedActual.some((value, index) => value !== normalizedExpected[index]) || new Set(normalizedActual).size !== normalizedActual.length) errors.push('candidate token model limits differ from the exact expected model set')
  if (!positiveInteger(data.remain_quota) || !positiveInteger(expected.maxRemainingQuota) || data.remain_quota > expected.maxRemainingQuota) errors.push('candidate token remaining quota must be positive and within budget')
  if (!positiveInteger(data.expired_time) || !positiveInteger(expected.maxExpirySeconds) || data.expired_time <= nowSeconds || data.expired_time > expected.maxExpirySeconds || data.expired_time > nowSeconds + 24 * 3600) errors.push('candidate token expiry must be finite and within 24 hours and the approved window')
  return errors
}

export interface CandidatePreflightBundle {
  expectedUserId: string
  expectedOrigin: string
  expectedModelByModality: Record<'text' | 'image' | 'image_edit' | 'ocr' | 'video', string>
  sessionReports: SessionInspection[]
  managementSelf?: { httpStatus: number; observedAt: string; origin: string; response: unknown }
  keys: Array<{ expected: CandidateKeyExpectation; readback: unknown }>
}

/** Cross-replica metadata and readback contract, not proof that supplied HTTP captures are authentic. */
export function validateNewApiCandidatePreflight(bundle: CandidatePreflightBundle, now = new Date()): string[] {
  const errors: string[] = []
  if (!nonEmpty(bundle.expectedUserId)) errors.push('expected management user id is required')
  let origin = ''
  try {
    const parsed = new URL(bundle.expectedOrigin)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error()
    origin = parsed.origin
  } catch { errors.push('expected relay must be an exact HTTPS origin') }
  if (!Array.isArray(bundle.sessionReports) || bundle.sessionReports.length < 2) errors.push('at least two replica session reports are required')
  else {
    const first = bundle.sessionReports[0]!
    const digest = createHash('sha256').update(bundle.expectedUserId.trim()).digest('hex')
    const replicaIds = new Set<string>()
    for (const report of bundle.sessionReports) {
      if (!nonEmpty(report.replica_id) || replicaIds.has(report.replica_id)) errors.push('replica reports must identify distinct containers')
      replicaIds.add(report.replica_id)
      if (report.schema_version !== '1' || report.expected_user_digest !== digest || !report.user_id_matches || !report.has_refresh_cookie || !report.has_access_token) errors.push('replica session identity or credentials are not ready')
      if (report.session_path !== first.session_path || report.runtime_uid !== first.runtime_uid || report.directory_uid !== first.directory_uid || report.directory_dev !== first.directory_dev || report.directory_ino !== first.directory_ino || report.directory_mode !== 0o700 || report.session_mode !== 0o600 || report.session_uid !== report.runtime_uid) errors.push('replica session path, owner, permission or shared directory identity differs')
    }
  }
  const management = bundle.managementSelf
  const selfRoot = record(management?.response)
  const selfData = record(selfRoot?.data)
  const observedAt = Date.parse(management?.observedAt ?? '')
  if (!management || management.httpStatus !== 200 || management.origin !== origin || selfRoot?.success !== true || String(selfData?.id ?? '') !== bundle.expectedUserId.trim() || !Number.isFinite(observedAt) || observedAt > now.getTime() + 300_000 || now.getTime() - observedAt > 15 * 60_000) errors.push('authenticated management self readback is missing, stale or mismatched')
  if (!Array.isArray(bundle.keys) || !bundle.keys.length) errors.push('candidate token readbacks are missing')
  else {
    const requiredModalities = ['text', 'image', 'image_edit', 'ocr', 'video'] as const
    const modelMap = record(bundle.expectedModelByModality)
    const requiredModels = requiredModalities.map(modality => modelMap?.[modality])
    if (requiredModels.some(model => !nonEmpty(model))) errors.push('all five modality models must be specified')
    const assignedModels = bundle.keys.flatMap(key => key.expected.models).map(model => model.trim()).sort()
    const distinctAssigned = [...new Set(assignedModels)]
    const distinctRequired = [...new Set(requiredModels.filter(nonEmpty))].sort()
    if (distinctAssigned.length !== distinctRequired.length || distinctAssigned.some((model, index) => model !== distinctRequired[index])) errors.push('candidate key model assignments must exactly cover five modality models')
    const ids = new Set<number>()
    for (const key of bundle.keys) {
      if (ids.has(key.expected.id)) errors.push('candidate token ids must be unique')
      ids.add(key.expected.id)
      errors.push(...validateCandidateKeyReadback(key.readback, key.expected, Math.floor(now.getTime() / 1000)))
    }
  }
  return [...new Set(errors)]
}

async function main() {
  const args = process.argv.slice(2)
  if (args[0] === 'inspect' && args.length === 3) {
    const report = await inspectNewApiSession(args[1]!, args[2]!)
    console.log(JSON.stringify(report))
    return
  }
  if (args[0] === 'validate' && args.length === 2) {
    const bundle = JSON.parse(await readFile(args[1]!, 'utf8')) as CandidatePreflightBundle
    const errors = validateNewApiCandidatePreflight(bundle)
    console.log(JSON.stringify({ state: errors.length ? 'blocked' : 'contract_passed', errors }))
    if (errors.length) process.exitCode = 1
    return
  }
  throw new Error('usage: new-api-candidate-preflight inspect <session-file> <expected-user-id> | validate <bundle-json>')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const code = error instanceof Error && /^NEW_API_PREFLIGHT_[A-Z_]+$/u.test(error.message) ? error.message : 'NEW_API_PREFLIGHT_FAILED'
    console.error(JSON.stringify({ state: 'blocked', code }))
    process.exitCode = 1
  })
}
