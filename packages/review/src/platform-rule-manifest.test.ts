import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PLATFORM_RULE_SOURCES } from './platform-rule-sync.js'
import { verifyAndParsePlatformRuleManifest } from './platform-rule-manifest.js'

describe('signed platform rule manifest', () => {
  const secret = 'manifest-test-secret'
  const raw = JSON.stringify({ schema_version: '1', generated_at: '2026-08-28T00:00:00.000Z', entries: [{ platform: 'taobao', pack_id: 'taobao-content', name: '淘宝内容规则', version: '2026.08.28', source_reference: PLATFORM_RULE_SOURCES.find(item => item.platform === 'taobao')!.officialUrl, source_checked_at: '2026-08-28T00:00:00.000Z', checks: { forbidden_terms: ['绝对第一'] }, severity: 'error', action: 'block' }] })
  const signature = createHmac('sha256', secret).update(raw).digest('hex')

  it('accepts a correctly signed manifest bound to the official platform source', () => {
    expect(verifyAndParsePlatformRuleManifest(raw, signature, secret)).toMatchObject({ schemaVersion: '1', entries: [{ platform: 'taobao', checks: { forbiddenTerms: ['绝对第一'] } }] })
  })

  it('rejects tampering and a platform/source mismatch', () => {
    expect(() => verifyAndParsePlatformRuleManifest(raw.replace('绝对第一', '篡改'), signature, secret)).toThrow('RULE_MANIFEST_SIGNATURE_INVALID')
    const mismatched = raw.replace(PLATFORM_RULE_SOURCES.find(item => item.platform === 'taobao')!.officialUrl, PLATFORM_RULE_SOURCES.find(item => item.platform === 'jd')!.officialUrl)
    expect(() => verifyAndParsePlatformRuleManifest(mismatched, createHmac('sha256', secret).update(mismatched).digest('hex'), secret)).toThrow('RULE_MANIFEST_SOURCE_MISMATCH')
  })
})
