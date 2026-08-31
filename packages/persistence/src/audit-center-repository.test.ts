import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { AuditCenterCursorError, MemoryAuditCenterRepository, redactAuditEvidence, redactAuditReason } from './audit-center-repository.js'

const row = (id: string, workspace_id: string, occurred_at: string, evidence: Record<string, unknown> = {}) => ({ id, source: 'operation' as const, workspace_id, actor_id: '=actor', action: 'member.update', resource_type: 'member', resource_id: id, reason: 'approved', occurred_at, evidence })
describe('audit center repository', () => {
  it('isolates tenants and uses a stable compound cursor', async () => {
    const repo = new MemoryAuditCenterRepository([row('a', 'ws_1', '2026-08-29T00:00:00Z'), row('b', 'ws_1', '2026-08-29T00:00:00Z'), row('c', 'ws_2', '2026-08-29T00:00:00Z')])
    const first = await repo.list({ workspaceId: 'ws_1', limit: 1 }); const second = await repo.list({ workspaceId: 'ws_1', limit: 1, cursor: first.nextCursor })
    expect(first.records).toHaveLength(1); expect(first.totalRecords).toBe(2); expect(first.truncated).toBe(true)
    expect(second.records).toHaveLength(1); expect(second.totalRecords).toBe(2); expect(second.truncated).toBe(false); expect(second.records[0]?.id).not.toBe(first.records[0]?.id)
    expect((await repo.list({ workspaceId: 'ws_2', limit: 10 })).records.map(item => item.id)).toEqual(['c'])
  })
  it('binds cursors to filters', async () => { const repo = new MemoryAuditCenterRepository([row('a', 'ws_1', '2026-08-29T00:00:00Z'), row('b', 'ws_1', '2026-08-28T00:00:00Z')]); const page = await repo.list({ workspaceId: 'ws_1', limit: 1 }); await expect(repo.list({ workspaceId: 'ws_1', text: 'member', limit: 1, cursor: page.nextCursor })).rejects.toBeInstanceOf(AuditCenterCursorError) })
  it('recursively redacts snake-case and camel-case secret evidence', () => { expect(redactAuditEvidence({ safe: 'ok', nested: { access_token: 'secret', accessToken: 'secret-2', customerEmail: 'private@example.com', count: 2 } })).toEqual({ redacted: true, fields: { safe: 'ok', 'nested.count': 2 }, omittedFields: 3 }) })
  it('redacts PII embedded in otherwise safe free-text evidence and reasons', () => {
    const evidence = redactAuditEvidence({ operatorNote: '联系 alice@example.com 或 138-0013-8000', safe: 'approved' })
    expect(evidence.fields).toEqual({ operatorNote: '联系 [REDACTED] 或 [REDACTED]', safe: 'approved' })
    expect(redactAuditReason('复核联系人 alice@example.com，电话 13800138000')).toBe('复核联系人 [REDACTED]，电话 [REDACTED]')
  })
  it('does not expose customer product or asset正文 through audit evidence', () => {
    const evidence = redactAuditEvidence({ after: { title: '客户商品标题', detail: '商品详情正文', content: '素材解析正文', body: '营销文案', safeState: 'approved' } })
    expect(evidence.fields).toEqual({ 'after.safeState': 'approved' })
    expect(evidence.omittedFields).toBe(4)
  })
  it('bounds and redacts sensitive audit reasons', () => {
    expect(redactAuditReason('authorization:Bearer-secret token=sk-test password=hunter2 正常复核')).toBe('authorization=[REDACTED] token=[REDACTED] password=[REDACTED] 正常复核')
    expect(redactAuditReason('x'.repeat(1_001))).toHaveLength(1_000)
  })
  it('keeps the SQL projection invoker-scoped and operation history immutable', async () => { const sql = await readFile(new URL('./migrations/059_ops_audit_center.sql', import.meta.url), 'utf8'); expect(sql).toContain('security_invoker = true'); expect(sql).toContain('workspace_operation_audit_immutable'); expect(sql).toContain('REVOKE ALL ON ops_audit_center FROM PUBLIC'); expect(sql).not.toContain('CREATE TABLE ops_audit_center') })
})
