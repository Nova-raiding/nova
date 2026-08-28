import { createHmac, timingSafeEqual } from 'node:crypto'
import { PLATFORM_RULE_SOURCES, type RuleSyncPlatform } from './platform-rule-sync.js'

export interface SignedPlatformRuleEntry {
  platform: RuleSyncPlatform
  packId: string
  name: string
  version: string
  sourceReference: string
  sourceCheckedAt: string
  checks: { forbiddenTerms?: string[]; requiredFields?: string[] }
  severity: 'error' | 'warning'
  action: 'block' | 'warn' | 'review' | 'allow'
  effectiveFrom?: string
  effectiveTo?: string
}

export interface SignedPlatformRuleManifest {
  schemaVersion: '1'
  generatedAt: string
  entries: SignedPlatformRuleEntry[]
}

function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function cleanId(value: unknown, field: string) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(value)) throw new Error(`RULE_MANIFEST_${field.toUpperCase()}_INVALID`)
  return value
}
function cleanText(value: unknown, field: string, max = 240) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`RULE_MANIFEST_${field.toUpperCase()}_INVALID`)
  return value.trim()
}
function cleanDate(value: unknown, field: string) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error(`RULE_MANIFEST_${field.toUpperCase()}_INVALID`)
  return new Date(value).toISOString()
}
function cleanStringList(value: unknown, field: string) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 500 || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 120 || /[\u0000-\u001f\u007f]/u.test(item))) throw new Error(`RULE_MANIFEST_${field.toUpperCase()}_INVALID`)
  return [...new Set(value.map(item => String(item).trim()))]
}

export function verifyAndParsePlatformRuleManifest(raw: string, signature: string, secret: string): SignedPlatformRuleManifest {
  if (!secret.trim() || !/^[a-f0-9]{64}$/iu.test(signature)) throw new Error('RULE_MANIFEST_SIGNATURE_INVALID')
  const expected = createHmac('sha256', secret).update(raw).digest()
  const supplied = Buffer.from(signature, 'hex')
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('RULE_MANIFEST_SIGNATURE_INVALID')
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('RULE_MANIFEST_JSON_INVALID') }
  if (!record(parsed) || parsed.schema_version !== '1' || !Array.isArray(parsed.entries) || parsed.entries.length < 1 || parsed.entries.length > 100) throw new Error('RULE_MANIFEST_SCHEMA_INVALID')
  const generatedAt = cleanDate(parsed.generated_at, 'generated_at')
  const sources = new Map(PLATFORM_RULE_SOURCES.map(source => [source.platform, source]))
  const seen = new Set<string>()
  const entries = parsed.entries.map((value): SignedPlatformRuleEntry => {
    if (!record(value) || !sources.has(value.platform as RuleSyncPlatform) || !record(value.checks)) throw new Error('RULE_MANIFEST_ENTRY_INVALID')
    const platform = value.platform as RuleSyncPlatform
    const sourceReference = cleanText(value.source_reference, 'source_reference', 500)
    if (sourceReference !== sources.get(platform)!.officialUrl) throw new Error('RULE_MANIFEST_SOURCE_MISMATCH')
    const packId = cleanId(value.pack_id, 'pack_id')
    const version = cleanId(value.version, 'version')
    const identity = `${platform}:${packId}:${version}`
    if (seen.has(identity)) throw new Error('RULE_MANIFEST_ENTRY_DUPLICATE')
    seen.add(identity)
    const effectiveFrom = value.effective_from === undefined ? undefined : cleanDate(value.effective_from, 'effective_from')
    const effectiveTo = value.effective_to === undefined ? undefined : cleanDate(value.effective_to, 'effective_to')
    if (effectiveFrom && effectiveTo && Date.parse(effectiveFrom) >= Date.parse(effectiveTo)) throw new Error('RULE_MANIFEST_EFFECTIVE_RANGE_INVALID')
    const severity = value.severity === 'warning' ? 'warning' : value.severity === 'error' || value.severity === undefined ? 'error' : undefined
    const action = value.action === 'warn' || value.action === 'review' || value.action === 'allow' || value.action === 'block' ? value.action : value.action === undefined ? 'block' : undefined
    if (!severity || !action) throw new Error('RULE_MANIFEST_POLICY_INVALID')
    const forbiddenTerms = cleanStringList(value.checks.forbidden_terms ?? value.checks.forbiddenTerms, 'forbidden_terms')
    const requiredFields = cleanStringList(value.checks.required_fields ?? value.checks.requiredFields, 'required_fields')
    return { platform, packId, name: cleanText(value.name, 'name'), version, sourceReference, sourceCheckedAt: cleanDate(value.source_checked_at, 'source_checked_at'), checks: { ...(forbiddenTerms ? { forbiddenTerms } : {}), ...(requiredFields ? { requiredFields } : {}) }, severity, action, ...(effectiveFrom ? { effectiveFrom } : {}), ...(effectiveTo ? { effectiveTo } : {}) }
  })
  return { schemaVersion: '1', generatedAt, entries }
}
