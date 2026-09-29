import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PLATFORM_RULE_SOURCES } from './platform-rule-sync.js'
import { verifyAndParsePlatformRuleManifest } from './platform-rule-manifest.js'

describe('signed platform rule manifest', () => {
  const secret = 'manifest-test-secret'
  const taobaoArticle = 'https://developer.alibaba.com/doc/doc.htm?articleId=120797&docType=1&treeId=23'
  const raw = JSON.stringify({ schema_version: '1', generated_at: '2026-08-28T00:00:00.000Z', entries: [{ platform: 'taobao', pack_id: 'taobao-content', name: '淘宝内容规则', version: '2026.08.28', source_reference: taobaoArticle, source_checked_at: '2026-08-28T00:00:00.000Z', checks: { forbidden_terms: ['绝对第一'], conflict_keys: ['absolute-claim'] }, severity: 'error', action: 'block' }] })
  const signature = createHmac('sha256', secret).update(raw).digest('hex')

  it('accepts a correctly signed manifest bound to the official platform source', () => {
    expect(verifyAndParsePlatformRuleManifest(raw, signature, secret)).toMatchObject({ schemaVersion: '1', entries: [{ platform: 'taobao', checks: { forbiddenTerms: ['绝对第一'], conflictKeys: ['absolute-claim'] } }] })
  })

  it('rejects tampering and a platform/source mismatch', () => {
    expect(() => verifyAndParsePlatformRuleManifest(raw.replace('绝对第一', '篡改'), signature, secret)).toThrow('RULE_MANIFEST_SIGNATURE_INVALID')
    const mismatched = raw.replace(taobaoArticle, PLATFORM_RULE_SOURCES.find(item => item.platform === 'jd')!.officialUrl)
    expect(() => verifyAndParsePlatformRuleManifest(mismatched, createHmac('sha256', secret).update(mismatched).digest('hex'), secret)).toThrow('RULE_MANIFEST_SOURCE_MISMATCH')
    const lookalike = raw.replace(taobaoArticle, 'https://developer.alibaba.com.evil.example/doc/doc.htm?articleId=120797')
    expect(() => verifyAndParsePlatformRuleManifest(lookalike, createHmac('sha256', secret).update(lookalike).digest('hex'), secret)).toThrow('RULE_MANIFEST_SOURCE_MISMATCH')
    const wrongPath = raw.replace(taobaoArticle, 'https://developer.alibaba.com/untrusted/article/120797')
    expect(() => verifyAndParsePlatformRuleManifest(wrongPath, createHmac('sha256', secret).update(wrongPath).digest('hex'), secret)).toThrow('RULE_MANIFEST_SOURCE_MISMATCH')
  })

  it('rejects stale, future-dated, empty-check and out-of-window manifests', () => {
    const now = '2026-09-30T00:00:00.000Z'
    const signed = (value: string) => createHmac('sha256', secret).update(value).digest('hex')
    const base = JSON.parse(raw) as Record<string, any>
    expect(() => verifyAndParsePlatformRuleManifest(raw, signature, secret, { now })).toThrow('RULE_MANIFEST_STALE')
    const future = JSON.stringify({ ...base, generated_at: '2026-09-30T00:10:00.000Z' })
    expect(() => verifyAndParsePlatformRuleManifest(future, signed(future), secret, { now })).toThrow('RULE_MANIFEST_GENERATED_AT_FUTURE')
    const empty = JSON.stringify({ ...base, generated_at: now, entries: [{ ...base.entries[0], source_checked_at: now, checks: {} }] })
    expect(() => verifyAndParsePlatformRuleManifest(empty, signed(empty), secret, { now })).toThrow('RULE_MANIFEST_CHECKS_EMPTY')
    const checkedInFuture = JSON.stringify({ ...base, generated_at: now, entries: [{ ...base.entries[0], source_checked_at: '2026-09-30T00:06:00.000Z' }] })
    expect(() => verifyAndParsePlatformRuleManifest(checkedInFuture, signed(checkedInFuture), secret, { now })).toThrow('RULE_MANIFEST_SOURCE_CHECKED_AT_INVALID')
  })
})
