import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PersistedRuleAudit, PersistedRuleVersion } from '../../../packages/persistence/src/index.js'
import { PLATFORM_RULE_SOURCES } from '../../../packages/review/src/platform-rule-sync.js'
import { setRuleRepositoryForTests, syncSignedPlatformRules } from './server.js'

describe('signed platform rule scheduler', () => {
  afterEach(() => { setRuleRepositoryForTests(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

  it('imports and activates a correctly signed platform rule manifest', async () => {
    const workspaceId = `ws_rule_scheduler_${Date.now()}`
    const secret = 'scheduler-test-secret'
    const raw = JSON.stringify({ schema_version: '1', generated_at: '2026-08-28T00:00:00.000Z', entries: [{ platform: 'taobao', pack_id: 'taobao-scheduled', name: '淘宝定时规则', version: '2026.08.28', source_reference: PLATFORM_RULE_SOURCES.find(item => item.platform === 'taobao')!.officialUrl, source_checked_at: '2026-08-28T00:00:00.000Z', checks: { forbidden_terms: ['定时禁词'] }, severity: 'error', action: 'block' }] })
    const signature = createHmac('sha256', secret).update(raw).digest('hex')
    const versions: PersistedRuleVersion[] = []
    const audits: PersistedRuleAudit[] = []
    setRuleRepositoryForTests({
      list: async scope => versions.filter(item => item.workspaceId === scope),
      insertVersion: async input => ({ ...input, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
      appendAudit: async input => { audits.push(input); return input },
      listAudit: async () => audits,
      updateStatus: async input => { const item = versions.find(value => value.id === input.id)!; item.status = input.status; item.revision = input.revision; return item },
      insertVersionWithAudit: async input => { const version = { ...input.version, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; versions.push(version); audits.push(input.audit); return { version, audit: input.audit } },
      transitionStatusWithAudit: async input => { const version = versions.find(item => item.id === input.targetId)!; version.status = input.status; version.revision += 1; const audit = { id: input.targetAuditId, workspaceId: input.workspaceId, rulePackId: input.packId, ruleVersionId: version.id, version: version.version, action: 'activated', actorId: input.actorId, reason: input.reason, occurredAt: input.occurredAt, data: input.auditData ?? {} }; audits.push(audit); return { version, audits: [audit] } },
    })
    vi.stubEnv('PLATFORM_RULE_SYNC_MANIFEST_URL', 'https://rules.example.com/platform-rules/v1/manifest.json')
    vi.stubEnv('PLATFORM_RULE_SYNC_SIGNING_SECRET', secret)
    vi.stubEnv('PLATFORM_RULE_SYNC_INTERVAL_HOURS', '24')
    vi.stubGlobal('fetch', async () => new Response(raw, { status: 200, headers: { 'x-rule-manifest-signature': signature } }))
    const result = await syncSignedPlatformRules(workspaceId)
    expect(result).toMatchObject({ state: 'succeeded', imported: 1, activated: 1, versions: [{ platform: 'taobao', pack_id: 'taobao-scheduled', version: '2026.08.28', state: 'active' }] })
    expect(versions[0]).toMatchObject({ workspaceId, scope: 'platform', targetId: 'taobao', status: 'active', checks: { forbiddenTerms: ['定时禁词'] }, checksum: expect.stringMatching(/^[a-f0-9]{64}$/u) })
  })
})
