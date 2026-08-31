import { createHash } from 'node:crypto'
import type { DeliveryDevice, DeliveryPlatform, DeliverySpecification } from './delivery-variant-planner.js'

export interface PlatformMediaSpecRuntimeRecord {
  readonly id: string
  readonly platform: DeliveryPlatform
  readonly placement: string
  readonly device: DeliveryDevice
  readonly version: string
  readonly specJson: Readonly<Record<string, unknown>>
  readonly sourceUrl: string
  readonly sourceSha256: string
  readonly checkedAt: string
  readonly evidenceArtifactRef?: string
  readonly evidenceArtifactSha256?: string
  readonly immutableDigest: string
  readonly status: 'draft' | 'approved' | 'expired'
  readonly expiresAt?: string
  readonly revision: number
  readonly approvedBy?: string
  readonly approvedAt?: string
}

export interface PlatformMediaSpecRuntimeFinding {
  readonly code: 'SPEC_MISSING' | 'SCOPE_MISMATCH' | 'SPEC_NOT_ACTIVE' | 'SPEC_EXPIRED' | 'EVIDENCE_REQUIRED' | 'IMMUTABLE_DIGEST_MISMATCH' | 'SPEC_JSON_INVALID' | 'DUPLICATE_ACTIVE_SPEC'
  readonly path: string
  readonly message: string
  readonly recordId?: string
}

export interface PlatformMediaSpecRuntimeResult {
  readonly ok: boolean
  readonly specifications: readonly DeliverySpecification[]
  readonly findings: readonly PlatformMediaSpecRuntimeFinding[]
}

const SHA256 = /^[a-f0-9]{64}$/u
const FORMAT = new Set(['jpg', 'png', 'webp'])

function canonicalize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value === undefined) return undefined
  if (typeof value !== 'object' || seen.has(value)) return null
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map(item => canonicalize(item, seen))
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child, seen)]))
  } finally { seen.delete(value) }
}

export function platformMediaSpecImmutableDigest(record: Pick<PlatformMediaSpecRuntimeRecord, 'platform' | 'placement' | 'device' | 'version' | 'specJson' | 'sourceUrl' | 'sourceSha256' | 'checkedAt' | 'evidenceArtifactRef' | 'evidenceArtifactSha256' | 'expiresAt'>): string {
  const value = {
    platform: record.platform, placement: record.placement, device: record.device, version: record.version,
    specJson: record.specJson, sourceUrl: record.sourceUrl, sourceSha256: record.sourceSha256, checkedAt: record.checkedAt,
    evidenceArtifactRef: record.evidenceArtifactRef, evidenceArtifactSha256: record.evidenceArtifactSha256, expiresAt: record.expiresAt,
  }
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

function timestamp(value: string | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return undefined
  return new Date(value).toISOString()
}

function specification(record: PlatformMediaSpecRuntimeRecord): DeliverySpecification | undefined {
  const json = record.specJson
  const width = json.width
  const height = json.height
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return undefined
  const safeZoneValue = json.safeZone
  const safeZone = safeZoneValue && typeof safeZoneValue === 'object' && !Array.isArray(safeZoneValue)
    ? safeZoneValue as { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
    : undefined
  const normalizedSafeZone = safeZone && [safeZone.x, safeZone.y, safeZone.width, safeZone.height].every(Number.isFinite)
    ? { x: safeZone.x as number, y: safeZone.y as number, width: safeZone.width as number, height: safeZone.height as number }
    : undefined
  const formats = Array.isArray(json.formats) && json.formats.every(value => typeof value === 'string' && FORMAT.has(value))
    ? [...new Set(json.formats)] as Array<'jpg' | 'png' | 'webp'>
    : undefined
  const maxCopyValue = json.maxCopyLength
  const maxCopyLength = maxCopyValue && typeof maxCopyValue === 'object' && !Array.isArray(maxCopyValue)
    ? Object.fromEntries(Object.entries(maxCopyValue).filter(([key, value]) => ['headline', 'subtitle', 'cta'].includes(key) && Number.isSafeInteger(value))) as DeliverySpecification['maxCopyLength']
    : undefined
  return {
    id: record.id, device: record.device, width: width as number, height: height as number,
    ...(normalizedSafeZone ? { safeZone: normalizedSafeZone } : {}),
    ...(maxCopyLength && Object.keys(maxCopyLength).length ? { maxCopyLength } : {}),
    ...(formats?.length ? { formats } : {}),
    ...(Number.isSafeInteger(json.maxFileBytes) ? { maxFileBytes: json.maxFileBytes as number } : {}),
    evidence: {
      state: 'production_canary', reference: `platform-media-spec:${record.id}@r${record.revision}:${record.immutableDigest}`, checkedAt: new Date(record.checkedAt).toISOString(),
      binding: {
        recordId: record.id, revision: record.revision, immutableDigest: record.immutableDigest,
        sourceSha256: record.sourceSha256, evidenceArtifactSha256: record.evidenceArtifactSha256!,
        approvedAt: new Date(record.approvedAt!).toISOString(), expiresAt: new Date(record.expiresAt!).toISOString(),
      },
    },
  }
}

/** Resolve only currently approved, immutable registry rows into planner input. */
export function resolvePlatformMediaSpecifications(input: {
  readonly platform: string
  readonly placement: string
  readonly devices: readonly DeliveryDevice[]
  readonly records: readonly PlatformMediaSpecRuntimeRecord[]
  readonly at?: string
}): PlatformMediaSpecRuntimeResult {
  const findings: PlatformMediaSpecRuntimeFinding[] = []
  const specifications: DeliverySpecification[] = []
  const at = timestamp(input.at) ?? new Date().toISOString()
  const platform = input.platform.normalize('NFKC').trim().toLocaleLowerCase('en-US')
  const placement = input.placement.normalize('NFKC').trim()
  for (const device of [...new Set(input.devices)]) {
    const candidates = input.records.filter(record => record.platform === platform && record.placement.normalize('NFKC').trim() === placement && record.device === device)
    if (!candidates.length) {
      const wrongScope = input.records.find(record => record.device === device)
      findings.push(wrongScope
        ? { code: 'SCOPE_MISMATCH', path: `records.${wrongScope.id}`, message: `${device} 规格不属于请求的平台或版位`, recordId: wrongScope.id }
        : { code: 'SPEC_MISSING', path: `devices.${device}`, message: `${device} 缺少 active platform media spec` })
      continue
    }
    if (candidates.length > 1) { findings.push({ code: 'DUPLICATE_ACTIVE_SPEC', path: `devices.${device}`, message: `${device} 返回多个候选规格，拒绝猜测 active 版本` }); continue }
    const record = candidates[0]!
    const recordPath = `records.${record.id}`
    if (record.platform !== platform || record.placement.normalize('NFKC').trim() !== placement || record.device !== device) {
      findings.push({ code: 'SCOPE_MISMATCH', path: recordPath, message: '规格平台、版位或设备范围不匹配', recordId: record.id }); continue
    }
    if (record.status !== 'approved' || !record.approvedBy?.trim() || !timestamp(record.approvedAt) || !Number.isSafeInteger(record.revision) || record.revision < 1) {
      findings.push({ code: 'SPEC_NOT_ACTIVE', path: recordPath, message: '规格不是带审批人的 approved revision', recordId: record.id }); continue
    }
    const expiresAt = timestamp(record.expiresAt)
    if (!expiresAt || expiresAt <= at) { findings.push({ code: 'SPEC_EXPIRED', path: `${recordPath}.expiresAt`, message: '规格证据已过期或缺少有效期', recordId: record.id }); continue }
    let sourceUrl: URL | undefined
    try { sourceUrl = new URL(record.sourceUrl) } catch { sourceUrl = undefined }
    const checkedAt = timestamp(record.checkedAt)
    const approvedAt = timestamp(record.approvedAt)
    const evidenceValid = sourceUrl?.protocol === 'https:' && !sourceUrl.username && !sourceUrl.password
      && SHA256.test(record.sourceSha256) && Boolean(record.evidenceArtifactRef?.trim()) && SHA256.test(record.evidenceArtifactSha256 ?? '')
      && Boolean(checkedAt && approvedAt && checkedAt <= approvedAt && approvedAt <= at)
    if (!evidenceValid) { findings.push({ code: 'EVIDENCE_REQUIRED', path: `${recordPath}.evidence`, message: '规格缺少完整来源、artifact、SHA 或 checkedAt 证据', recordId: record.id }); continue }
    if (!SHA256.test(record.immutableDigest) || platformMediaSpecImmutableDigest(record) !== record.immutableDigest) {
      findings.push({ code: 'IMMUTABLE_DIGEST_MISMATCH', path: `${recordPath}.immutableDigest`, message: '规格不可变证据摘要不匹配', recordId: record.id }); continue
    }
    const resolved = specification(record)
    if (!resolved) { findings.push({ code: 'SPEC_JSON_INVALID', path: `${recordPath}.specJson`, message: '规格 JSON 缺少可验证的整数宽高', recordId: record.id }); continue }
    specifications.push(resolved)
  }
  return Object.freeze({ ok: findings.length === 0 && specifications.length === new Set(input.devices).size, specifications: Object.freeze(specifications), findings: Object.freeze(findings) })
}
