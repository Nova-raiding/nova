import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { operationAudits, server } from './server.js'

type RpcEnvelope<T = unknown> = { data: { result: T } | null; error: { code: string; message: string } | null }

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

describe('Audit Center and member concurrency API integration', () => {
  beforeEach(() => vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000'))
  afterEach(async () => {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    vi.unstubAllEnvs()
  })

  it('serves bounded, workspace-scoped Audit Center records and redacts detail evidence', async () => {
    const workspaceId = `ws_audit_center_${Date.now()}`
    const foreignWorkspaceId = `${workspaceId}_foreign`
    await operationAudits.append({
      workspaceId,
      actorId: 'platform-auditor',
      action: 'credential.rotation.review',
      resourceType: 'integration_test',
      resourceId: 'audit-sensitive-1',
      before: { status: 'pending', access_token: 'must-not-leak' },
      after: { status: 'approved', nested: { payment_url: 'https://payments.invalid/secret', safe_count: 2 }, customer_email: 'private@example.com' },
      reason: '验证审计证据最小化投影',
    })
    const base = await start()
    const call = <T>(method: string, params: Record<string, unknown>, role = 'support', requestWorkspaceId = workspaceId) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-id': requestWorkspaceId, 'x-role': role, 'x-actor-id': `${role}-auditor` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { workspace_id: requestWorkspaceId, ...params } }),
    }).then(response => response.json() as Promise<RpcEnvelope<T>>)

    const listed = await call<{ records: Array<{ id: string; workspaceId: string; redacted: true }> }>('ops.audit.list', { sources_json: JSON.stringify(['operation']), limit: '10' })
    expect(listed.error).toBeNull()
    const record = listed.data?.result.records.find(item => item.id)
    expect(record).toMatchObject({ workspaceId, redacted: true })

    const detail = await call<{ evidence: { redacted: true; fields: Record<string, unknown>; omittedFields: number } }>('ops.audit.detail', { source: 'operation', id: record!.id })
    expect(detail.error).toBeNull()
    expect(detail.data?.result.evidence).toMatchObject({ redacted: true, fields: { 'before.status': 'pending', 'after.status': 'approved', 'after.nested.safe_count': 2 } })
    expect(JSON.stringify(detail.data?.result.evidence.fields)).not.toMatch(/must-not-leak|payments\.invalid|private@example\.com/u)
    expect(detail.data?.result.evidence.omittedFields).toBeGreaterThanOrEqual(3)

    expect((await call('ops.audit.export', {}, 'support')).error?.code).toBe('AUDIT_CENTER_FORBIDDEN')
    const exported = await call<{ csv: string; rowCount: number }>('ops.audit.export', {}, 'finance')
    expect(exported.error).toBeNull()
    expect(exported.data?.result).toMatchObject({ rowCount: 1 })
    expect(exported.data?.result.csv).not.toMatch(/must-not-leak|payments\.invalid|private@example\.com/u)

    const crossWorkspace = await call('ops.audit.list', { workspace_id: foreignWorkspaceId }, 'support')
    expect(crossWorkspace.error?.code).toBe('WORKSPACE_SCOPE_MISMATCH')
    expect((await call('ops.audit.list', { limit: '101' })).error?.code).toBe('INVALID_REQUEST')
  })

  it('uses the client revision for member updates and suspension instead of refreshing it server-side', async () => {
    const workspaceId = `ws_member_cas_${Date.now()}`
    const base = await start()
    const call = <T>(method: string, params: Record<string, unknown>) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-role': 'merchant_admin', 'x-actor-id': 'member-admin' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { workspace_id: workspaceId, ...params } }),
    }).then(response => response.json() as Promise<RpcEnvelope<T>>)

    const invited = await call<{ revision: number }>('ops.member.upsert', { external_subject: 'cas-user', display_name: 'CAS User', role: 'operator', status: 'invited', reason: '邀请成员参与运营' })
    expect(invited.data?.result.revision).toBe(1)
    const updated = await call<{ revision: number; role: string }>('ops.member.upsert', { external_subject: 'cas-user', display_name: 'CAS User', role: 'support', status: 'active', expected_revision: '1', reason: '分配客服职责' })
    expect(updated.data?.result).toMatchObject({ revision: 2, role: 'support' })
    const listed = await call<Array<{ externalSubject: string; governance?: { protectedTarget: boolean; canChangeTarget: boolean; canDeactivateTarget: boolean } }>>('ops.members.list', {})
    expect(listed.data?.result).toEqual(expect.arrayContaining([expect.objectContaining({ externalSubject: 'cas-user', governance: { protectedTarget: false, canChangeTarget: true, canDeactivateTarget: true } })]))

    const staleRole = await call('ops.member.upsert', { external_subject: 'cas-user', display_name: 'CAS User', role: 'finance', status: 'active', expected_revision: '1', reason: '陈旧页面尝试改角色' })
    expect(staleRole.error?.code).toBe('MEMBER_REVISION_CONFLICT')
    const staleSuspend = await call('ops.member.suspend', { external_subject: 'cas-user', expected_revision: '1', reason: '陈旧页面尝试停用' })
    expect(staleSuspend.error?.code).toBe('MEMBER_REVISION_CONFLICT')

    const suspended = await call<{ revision: number; status: string }>('ops.member.suspend', { external_subject: 'cas-user', expected_revision: '2', reason: '访问复核后停用' })
    expect(suspended.data?.result).toMatchObject({ revision: 3, status: 'suspended' })
    const missingRevision = await call('ops.member.upsert', { external_subject: 'cas-user', display_name: 'CAS User', role: 'operator', status: 'active', reason: '缺少并发版本' })
    expect(missingRevision.error?.code).toBe('INVALID_REQUEST')
  })
})
