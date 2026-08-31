import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server, workspaceMembers } from './server.js'

type RpcEnvelope<T = unknown> = {
  request_id?: string
  trace_id?: string
  workspace_id?: string
  data: { result: T } | null
  warnings?: unknown[]
  next_actions?: unknown[]
  error: { code: string; message: string } | null
}

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

describe('Ops domain API integration', () => {
  beforeEach(() => vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000'))
  afterEach(async () => {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    vi.unstubAllEnvs()
  })

  it('wires support tickets with server-bound workspace, replay safety, revision conflicts, and CRM RBAC', async () => {
    const base = await start()
    const workspaceId = `ws_ops_support_${Date.now()}`
    const call = <T>(method: string, params: Record<string, unknown>, role = 'support') => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-role': role, 'x-actor-id': `${role}-actor` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { workspace_id: workspaceId, ...params } }),
    }).then(response => response.json() as Promise<RpcEnvelope<T>>)

    const createParams = {
      subject: '支付到账异常', description: '客户充值后钱包余额没有更新', priority: 'urgent',
      customer_id: 'customer-1', customer_name: '测试客户', customer_email: 'customer@example.com',
      tags_json: JSON.stringify(['payment', 'urgent']), idempotency_key: 'support-create-0001',
    }
    const created = await call<{ ticket: { id: string; revision: number }; replayed: boolean }>('ops.support.ticket.create', createParams)
    expect(created.error).toBeNull()
    expect(created.data?.result).toMatchObject({ ticket: { revision: 1 }, replayed: false })
    const replay = await call<{ ticket: { id: string }; replayed: boolean }>('ops.support.ticket.create', createParams)
    expect(replay.data?.result).toMatchObject({ ticket: { id: created.data?.result.ticket.id }, replayed: true })

    const listed = await call<{ items: Array<{ id: string }> }>('ops.support.tickets.list', { limit: '25' })
    expect(listed.data?.result.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.data?.result.ticket.id })]))
    const assigned = await call<{ ticket: { revision: number } }>('ops.support.ticket.assign', { ticket_id: created.data?.result.ticket.id, assignee_id: 'support-owner', expected_revision: '1', idempotency_key: 'support-assign-0001' })
    expect(assigned.data?.result.ticket.revision).toBe(2)
    const stale = await call('ops.support.ticket.comment', { ticket_id: created.data?.result.ticket.id, body: '并发旧版本评论', visibility: 'internal', expected_revision: '1', idempotency_key: 'support-comment-0001' })
    expect(stale.error?.code).toBe('SUPPORT_TICKET_REVISION_CONFLICT')
    expect((await call('ops.support.crm.export', {})).error?.code).toBe('SUPPORT_FORBIDDEN')
    expect((await call('ops.support.crm.export', {}, 'platform_ops')).error?.code).toBe('SUPPORT_FORBIDDEN')
    const platformTickets = await call<{ items: Array<Record<string, unknown>>; aggregate: boolean }>('ops.support.tickets.list', { platform_scope: 'platform', limit: '25' }, 'platform_ops')
    expect(platformTickets.error?.code).toBe('FORBIDDEN')

    const mismatched = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-role': 'support' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ops.support.tickets.list', params: { workspace_id: `${workspaceId}_other` } }),
    }).then(response => response.json() as Promise<RpcEnvelope>)
    expect(mismatched.error?.code).toBe('WORKSPACE_SCOPE_MISMATCH')
  })

  it('wires incident response and keeps support mutation rights comment-only', async () => {
    const base = await start()
    const workspaceId = `ws_ops_incidents_${Date.now()}`
    const call = <T>(method: string, params: Record<string, unknown>, role: 'support' | 'platform_ops') => fetch(`${base}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-role': role, 'x-actor-id': `${role}-actor` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { workspace_id: workspaceId, ...params } }),
    }).then(response => response.json() as Promise<RpcEnvelope<T>>)

    const created = await call<{ incident: { id: string; revision: number } }>('ops.incident.create', {
      title: '支付服务不可用', summary: '充值和退款请求持续失败', severity: 'sev1', affected_components_json: JSON.stringify(['billing']), affected_workspace_ids_json: JSON.stringify([workspaceId]), idempotency_key: 'incident-create-0001',
    }, 'platform_ops')
    expect(created.error).toBeNull()
    const incident = created.data!.result.incident
    const comment = await call<{ incident: { revision: number }; event: { kind: string } }>('ops.incident.comment', { incident_id: incident.id, expected_revision: String(incident.revision), body: '客服已确认多个客户受影响', idempotency_key: 'incident-comment-0001' }, 'support')
    expect(comment.data?.result).toMatchObject({ incident: { revision: 2 }, event: { kind: 'comment' } })
    const forbidden = await call('ops.incident.transition', { incident_id: incident.id, expected_revision: '2', to_status: 'identified', note: '尝试越权推进', idempotency_key: 'incident-transition-0001' }, 'support')
    expect(forbidden.error?.code).toBe('INCIDENT_FORBIDDEN')
    const timeline = await call<{ items: Array<{ kind: string }> }>('ops.incident.timeline', { incident_id: incident.id, limit: '20' }, 'support')
    const platformIncidents = await call<{ items: Array<Record<string, unknown>>; aggregate: boolean }>('ops.incidents.list', { platform_scope: 'platform', limit: '20' }, 'platform_ops')
    expect(platformIncidents.error?.code).toBe('FORBIDDEN')
    expect(timeline.data?.result.items.map(item => item.kind)).toEqual(['created', 'comment'])
    const invalidPage = await call('ops.incidents.list', { limit: '101' }, 'support')
    expect(invalidPage.error?.code).toBe('INVALID_REQUEST')
  })

  it('wires platform feature flags with typed values, immutable events, and platform-only writes', async () => {
    const base = await start()
    const workspaceId = `ws_ops_flags_${Date.now()}`
    const call = <T>(method: string, params: Record<string, unknown>, role: string) => fetch(`${base}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-ops-workbench': 'platform', 'x-role': role, 'x-actor-id': `${role}-actor` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { workspace_id: workspaceId, ...params } }),
    }).then(response => response.json() as Promise<RpcEnvelope<T>>)

    const flag = { key: `checkout.new_flow_${Date.now()}`, environment: 'production', description: '新结账链路', default_value_json: JSON.stringify({ type: 'boolean', value: false }), enabled: 'true', targets_json: JSON.stringify([{ type: 'workspace', value: workspaceId, enabled: true }]), reason: '灰度验证新结账链路', idempotency_key: 'feature-save-0001' }
    expect((await call('ops.feature-flag.upsert', flag, 'support')).error?.code).toBe('FORBIDDEN')
    const saved = await call<{ flag: { id: string; revision: number }; replayed: boolean }>('ops.feature-flag.upsert', flag, 'platform_ops')
    expect(saved.data?.result).toMatchObject({ flag: { revision: 1 }, replayed: false })
    const evaluation = await call<{ enabled: boolean; matchedBy: string }>('ops.feature-flag.evaluate', { flag_key: flag.key, environment: 'production' }, 'operator')
    expect(evaluation.data?.result).toMatchObject({ enabled: true, matchedBy: 'workspace' })
    const events = await call<Array<{ eventType: string }>>('ops.feature-flag.events', { flag_id: saved.data?.result.flag.id, limit: '20' }, 'support')
    expect(events.data?.result).toEqual([expect.objectContaining({ eventType: 'created' })])
  })

  it('bounds Ops control-plane payloads and fails closed when finance search lacks durable persistence', async () => {
    const base = await start()
    const workspaceId = `ws_ops_bounds_${Date.now()}`
    const oversized = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-role': 'support' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ops.support.tickets.list', params: { workspace_id: workspaceId, query: 'x'.repeat(129 * 1024) } }),
    })
    expect(oversized.status).toBe(400)
    expect((await oversized.json() as RpcEnvelope).error?.code).toBe('INVALID_REQUEST')

    const financeResponse = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-role': 'finance', 'x-actor-id': 'finance-actor' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ops.finance.search', params: { workspace_ids_json: JSON.stringify([workspaceId]), limit: '25' } }),
    })
    const finance = await financeResponse.json() as RpcEnvelope
    expect(financeResponse.status).toBe(503)
    expect(finance.error?.code).toBe('FINANCE_SEARCH_REPOSITORY_UNAVAILABLE')
    expect(finance.data).toBeNull()
    expect(finance).toMatchObject({ workspace_id: workspaceId, warnings: [], next_actions: [] })
    expect(finance.request_id).toMatch(/^req_/)
    expect(finance.trace_id).toBe(finance.request_id)
  })

  it('returns stable empty-page envelopes and real not-found errors over HTTP', async () => {
    const base = await start()
    const workspaceId = `ws_ops_empty_${Date.now()}`
    const call = async <T>(method: string, params: Record<string, unknown>, role: string) => {
      const response = await fetch(`${base}/mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId, ...(method.startsWith('ops.feature-flag') ? { 'x-ops-workbench': 'platform' } : {}), 'x-role': role, 'x-actor-id': `${role}-actor` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params: { workspace_id: workspaceId, ...params } }),
      })
      return { response, envelope: await response.json() as RpcEnvelope<T> }
    }

    const support = await call<{ items: unknown[]; nextCursor?: unknown }>('ops.support.tickets.list', { limit: '25' }, 'support')
    const incidents = await call<{ items: unknown[]; nextCursor?: unknown }>('ops.incidents.list', { limit: '25' }, 'support')
    const flags = await call<{ items: unknown[]; nextCursor?: unknown }>('ops.feature-flags.list', { environment: `empty-${Date.now()}`, limit: '25' }, 'support')
    const audit = await call<{ records: unknown[]; nextCursor?: unknown }>('ops.audit.list', { limit: '25' }, 'support')

    for (const item of [support, incidents, flags, audit]) {
      expect(item.response.status).toBe(200)
      expect(item.envelope.error).toBeNull()
      expect(item.envelope).toMatchObject({ workspace_id: workspaceId, warnings: [], next_actions: [], data: { result: expect.any(Object) } })
      expect(item.envelope.request_id).toMatch(/^req_/)
      expect(item.envelope.trace_id).toBe(item.envelope.request_id)
    }
    expect(support.envelope.data?.result).toEqual({ items: [] })
    expect(incidents.envelope.data?.result).toEqual({ items: [] })
    expect(flags.envelope.data?.result).toEqual({ items: [] })
    expect(audit.envelope.data?.result).toEqual({ records: [], totalRecords: 0, truncated: false })

    const missing = await call('ops.support.ticket.get', { ticket_id: '00000000-0000-4000-8000-000000000001' }, 'support')
    expect(missing.response.status).toBe(404)
    expect(missing.envelope.data).toBeNull()
    expect(missing.envelope.error?.code).toBe('SUPPORT_TICKET_NOT_FOUND')
  })

  it('enforces authenticated membership and role claims before reaching Ops domain services', async () => {
    const workspaceId = `ws_ops_strict_${Date.now()}`
    const grants = {
      'ops-support-token': { workspaces: [workspaceId], actor_id: 'ops-support', roles: ['support'] },
      'ops-operator-token': { workspaces: [workspaceId], actor_id: 'ops-operator', roles: ['operator'] },
      'ops-platform-token': { workspaces: [workspaceId], actor_id: 'ops-platform', roles: ['platform_ops'], workbenches: ['platform'] },
    }
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'ops-integration-session-secret')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify(grants))
    await workspaceMembers.upsert({ workspaceId, externalSubject: 'ops-support', displayName: 'Support', role: 'support', status: 'active', invitedBy: 'test' })
    await workspaceMembers.upsert({ workspaceId, externalSubject: 'ops-operator', displayName: 'Operator', role: 'operator', status: 'active', invitedBy: 'test' })
    await workspaceMembers.upsert({ workspaceId, externalSubject: 'ops-platform', displayName: 'Platform Ops', role: 'platform_ops', status: 'active', invitedBy: 'test' })
    const base = await start()
    const call = (token: string, method: string, params: Record<string, unknown> = {}) => fetch(`${base}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { workspace_id: workspaceId, ...params } }),
    }).then(response => response.json() as Promise<RpcEnvelope>)

    expect((await call('ops-operator-token', 'ops.support.tickets.list')).error?.code).toBe('FORBIDDEN')
    expect((await call('ops-support-token', 'ops.support.tickets.list', { limit: '10' })).error).toBeNull()
    expect((await call('ops-support-token', 'ops.feature-flag.upsert', { key: 'strict.test', environment: 'production', description: 'Strict role check', default_value_json: JSON.stringify({ type: 'boolean', value: false }), idempotency_key: 'strict-feature-0001', reason: 'verify strict RBAC' })).error?.code).toBe('FORBIDDEN')
    expect((await call('ops-platform-token', 'ops.feature-flag.upsert', { key: 'strict.test', environment: 'production', description: 'Strict role check', default_value_json: JSON.stringify({ type: 'boolean', value: false }), idempotency_key: 'strict-feature-0001', reason: 'verify strict RBAC' })).error).toBeNull()
  })

  it('keeps global feature flag control available without granting merchant workspace membership', async () => {
    const workspaceId = `ws_ops_global_flags_${Date.now()}`
    const flagKey = `global.strict.${Date.now()}`
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'ops-global-flags-session-secret')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'global-platform-token': { workspaces: [workspaceId], actor_id: 'global-platform', roles: ['platform_ops'], workbenches: ['platform'] },
      'global-support-token': { workspaces: [workspaceId], actor_id: 'global-support', roles: ['support'], workbenches: ['platform'] },
    }))
    const base = await start()
    const call = async (token: string, method: string, params: Record<string, unknown> = {}) => {
      const response = await fetch(`${base}/mcp`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { workspace_id: workspaceId, ...params } }),
      })
      return { response, envelope: await response.json() as RpcEnvelope }
    }

    const saved = await call('global-platform-token', 'ops.feature-flag.upsert', {
      key: flagKey, environment: 'production', description: 'Global control-plane flag',
      default_value_json: JSON.stringify({ type: 'boolean', value: false }), enabled: 'false', targets_json: '[]',
      idempotency_key: `global-flag-${Date.now()}`, reason: 'verify global control plane access',
    })
    expect(saved.response.status).toBe(200)
    expect(saved.envelope.error).toBeNull()

    const listed = await call('global-support-token', 'ops.feature-flags.list', { environment: 'production', query: flagKey, limit: '25' })
    expect(listed.response.status).toBe(200)
    expect(listed.envelope.error).toBeNull()
    expect(listed.envelope.data?.result).toMatchObject({ items: [expect.objectContaining({ key: flagKey })] })

    const tenantScoped = await call('global-support-token', 'ops.support.tickets.list', { limit: '10' })
    expect(tenantScoped.response.status).toBe(403)
    expect(tenantScoped.envelope.error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_WORKBENCH_MISMATCH' } })
  })
})
