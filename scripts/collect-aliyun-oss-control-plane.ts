import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export type CommandResult = { status: number | null; stdout: string; stderr: string; error?: Error }
export type CommandExecutor = (binary: string, args: readonly string[]) => CommandResult | Promise<CommandResult>

type CheckReason = 'permission_denied' | 'not_configured' | 'disabled' | 'misconfigured' | 'unsupported' | 'invalid_response' | 'command_failed'
type ControlCheck = {
  state: 'passed' | 'failed' | 'blocked'
  reason?: CheckReason
  observed: boolean | number | null
}

export type AliyunOssControlPlaneResult = {
  schema_version: '1'
  provider: 'aliyun-oss'
  mode: 'read-only'
  bucket_sha256: string
  region: string
  endpoint_sha256: string
  lifecycle_rule_id_sha256: string
  observed_at: string
  ready: boolean
  checks: {
    versioning_enabled: ControlCheck
    lifecycle_enabled_rules: ControlCheck
    public_access_blocked: ControlCheck
  }
}

const commands = {
  versioning_enabled: 'get-bucket-versioning',
  lifecycle_enabled_rules: 'get-bucket-lifecycle',
  public_access_blocked: 'get-bucket-public-access-block',
} as const

const defaultExecutor: CommandExecutor = (binary, args) => {
  const result = spawnSync(binary, [...args], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error ? { error: result.error } : {}) }
}

function classifyFailure(result: CommandResult): CheckReason {
  const message = `${result.error?.message ?? ''}\n${result.stderr}\n${result.stdout}`.toLowerCase()
  if (/accessdenied|access denied|forbidden|status.?code.?403|\b403\b/u.test(message)) return 'permission_denied'
  if (/nosuchlifecycle|nosuchpublicaccessblock|not configured|configuration.*does not exist|status.?code.?404|\b404\b/u.test(message)) return 'not_configured'
  if (/unsupported|not implemented|unknown command|unknown flag|status.?code.?405|\b405\b|status.?code.?501|\b501\b/u.test(message)) return 'unsupported'
  return 'command_failed'
}

function parseJson(stdout: string): unknown {
  try { return JSON.parse(stdout) } catch { return undefined }
}

function findValues(value: unknown, target: string): unknown[] {
  if (Array.isArray(value)) return value.flatMap(item => findValues(item, target))
  if (!value || typeof value !== 'object') return []
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
    key.replaceAll('_', '').toLowerCase() === target.toLowerCase() ? [item] : findValues(item, target))
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string' && /^(true|enabled)$/iu.test(value.trim())) return true
  if (typeof value === 'string' && /^(false|disabled|suspended)$/iu.test(value.trim())) return false
  return undefined
}

function objectField(value: unknown, target: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return Object.entries(value as Record<string, unknown>)
    .find(([key]) => key.replaceAll('_', '').toLowerCase() === target.toLowerCase())?.[1]
}

function lifecycleRules(value: unknown): Record<string, unknown>[] {
  const rules = findValues(value, 'rule').flatMap(item => Array.isArray(item) ? item : [item])
  return rules.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
}

function lifecycleCheck(value: unknown, expectedRuleId: string): ControlCheck {
  const rules = lifecycleRules(value)
  const rule = rules.find(item => objectField(item, 'id') === expectedRuleId)
  if (!rule) return { state: 'failed', reason: 'not_configured', observed: 0 }

  const enabled = booleanValue(objectField(rule, 'status'))
  if (enabled === false) return { state: 'failed', reason: 'disabled', observed: 0 }
  const filter = objectField(rule, 'filter')
  const prefix = objectField(rule, 'prefix') ?? objectField(filter, 'prefix')
  const abortMultipartUpload = objectField(rule, 'abortmultipartupload')
  const multipartDays = Number(objectField(abortMultipartUpload, 'days'))
  const expiration = objectField(rule, 'expiration')
  const removeExpiredDeleteMarkers = booleanValue(objectField(expiration, 'expiredobjectdeletemarker'))
  const matches = enabled === true
    && prefix === 'merchant-assets/'
    && multipartDays === 7
    && removeExpiredDeleteMarkers === true
  return { state: matches ? 'passed' : 'failed', ...(!matches ? { reason: 'misconfigured' as const } : {}), observed: matches ? 1 : 0 }
}

function parseSuccessfulCheck(id: keyof typeof commands, stdout: string, lifecycleRuleId: string): ControlCheck {
  const value = parseJson(stdout)
  if (value === undefined) return { state: 'blocked', reason: 'invalid_response', observed: null }
  if (id === 'versioning_enabled') {
    const enabled = findValues(value, 'status').map(booleanValue).find(item => item !== undefined)
    if (enabled === undefined) return { state: 'failed', reason: 'not_configured', observed: false }
    return { state: enabled ? 'passed' : 'failed', ...(!enabled ? { reason: 'disabled' as const } : {}), observed: enabled }
  }
  if (id === 'public_access_blocked') {
    const blocked = findValues(value, 'blockpublicaccess').map(booleanValue).find(item => item !== undefined)
    if (blocked === undefined) return { state: 'failed', reason: 'not_configured', observed: false }
    return { state: blocked ? 'passed' : 'failed', ...(!blocked ? { reason: 'disabled' as const } : {}), observed: blocked }
  }
  return lifecycleCheck(value, lifecycleRuleId)
}

function validateInput(bucket: string, endpoint?: string) {
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/u.test(bucket)) throw new Error('OSS_BUCKET_INVALID')
  if (endpoint) {
    const parsed = new URL(endpoint)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('OSS_ENDPOINT_INVALID')
  }
}

export async function collectAliyunOssControlPlane(input: {
  bucket: string
  region: string
  lifecycleRuleId: string
  endpoint?: string
  binary?: string
  execute?: CommandExecutor
  now?: () => Date
}): Promise<AliyunOssControlPlaneResult> {
  validateInput(input.bucket, input.endpoint)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)+$/u.test(input.region)) throw new Error('OSS_REGION_INVALID')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u.test(input.lifecycleRuleId)) throw new Error('OSS_LIFECYCLE_RULE_ID_INVALID')
  const execute = input.execute ?? defaultExecutor
  const checks = {} as AliyunOssControlPlaneResult['checks']
  for (const [id, command] of Object.entries(commands) as Array<[keyof typeof commands, string]>) {
    const args = ['api', command, '--bucket', input.bucket, '--output-format', 'json', '--mode', 'EcsRamRole', '--region', input.region, ...(input.endpoint ? ['--endpoint', input.endpoint] : [])]
    const result = await execute(input.binary ?? 'ossutil', args)
    checks[id] = result.status === 0 && !result.error
      ? parseSuccessfulCheck(id, result.stdout, input.lifecycleRuleId)
      : { state: 'blocked', reason: classifyFailure(result), observed: null }
  }
  return {
    schema_version: '1', provider: 'aliyun-oss', mode: 'read-only',
    bucket_sha256: createHash('sha256').update(input.bucket).digest('hex'),
    region: input.region,
    endpoint_sha256: createHash('sha256').update(input.endpoint ?? '').digest('hex'),
    lifecycle_rule_id_sha256: createHash('sha256').update(input.lifecycleRuleId).digest('hex'),
    observed_at: (input.now ?? (() => new Date()))().toISOString(),
    ready: Object.values(checks).every(check => check.state === 'passed'), checks,
  }
}

export async function main() {
  try {
    const bucket = process.env.ASSET_STORAGE_BUCKET?.trim()
    if (!bucket) throw new Error('ASSET_STORAGE_BUCKET_REQUIRED')
    const region = process.env.ASSET_STORAGE_REGION?.trim()
    if (!region) throw new Error('ASSET_STORAGE_REGION_REQUIRED')
    const lifecyclePolicyRef = process.env.LIFECYCLE_POLICY_REF?.trim()
    const lifecycleRuleId = process.env.OSS_LIFECYCLE_RULE_ID?.trim()
      || lifecyclePolicyRef?.match(/\/lifecycle\/([^/]+)$/u)?.[1]
    if (!lifecycleRuleId) throw new Error('OSS_LIFECYCLE_RULE_ID_REQUIRED')
    const result = await collectAliyunOssControlPlane({ bucket, region, lifecycleRuleId, endpoint: process.env.ASSET_STORAGE_ENDPOINT?.trim() || undefined, binary: process.env.OSSUTIL_BINARY?.trim() || undefined })
    console.log(JSON.stringify(result, null, 2))
    if (!result.ready) process.exitCode = 1
  } catch (error) {
    console.error(JSON.stringify({ schema_version: '1', provider: 'aliyun-oss', mode: 'read-only', ready: false, reason: error instanceof Error ? error.message : 'CONTROL_PLANE_COLLECTION_FAILED' }))
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main()
