import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableCommercialFixtureHarnessForTests, server, service, workspaceMembers } from './server.js'

type Envelope = {
  data: { result?: Record<string, unknown> } | null
  error: { code: string } | null
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

async function call(base: string, token: string, workspaceId: string, method: string, params: Record<string, unknown>) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-ops-workbench': 'workspace',
      'x-workspace-id': workspaceId,
      'x-test-commercial-fixture': 'server-e2e',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
  })
  return { response, body: await response.json() as Envelope }
}

function result(body: Envelope) {
  return body.data && typeof body.data === 'object' && 'result' in body.data ? body.data.result : body.data
}

async function createTicket(base: string, workspaceId: string, supportToken: string, related: { related_task_id?: string; related_order_id?: string } = {}, suffix = '') {
  const created = await call(base, supportToken, workspaceId, 'ops.support.ticket.create', {
    subject: '回复可见性测试', description: '验证客服回复在商户侧的安全读取链路。', priority: 'normal',
    customer_id: 'customer-replies-test', customer_name: '测试商户', idempotency_key: `support-create-${workspaceId}-${suffix}`,
    ...related,
  })
  expect(created.response.status, JSON.stringify(created.body)).toBe(200)
  expect(created.body.error).toBeNull()
  return (result(created.body) as { ticket: { id: string; revision: number } }).ticket
}

async function comment(base: string, workspaceId: string, supportToken: string, ticketId: string, revision: number, visibility: 'internal' | 'customer', body: string) {
  const response = await call(base, supportToken, workspaceId, 'ops.support.ticket.comment', {
    ticket_id: ticketId, body, visibility, expected_revision: String(revision), idempotency_key: `support-comment-${workspaceId}-${visibility}-${crypto.randomUUID()}`,
  })
  expect(response.response.status, JSON.stringify(response.body)).toBe(200)
  expect(response.body.error).toBeNull()
  return (result(response.body) as { ticket: { revision: number } }).ticket
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'support-customer-replies-test-secret')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  enableCommercialFixtureHarnessForTests()
})

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  vi.unstubAllEnvs()
})

describe('customer-visible support replies MCP method', () => {
  it('returns customer comments only and never exposes raw or internal payloads', async () => {
    const workspaceId = `ws_customer_replies_${Date.now()}`
    const supportActor = `support-replies-${workspaceId}`
    const merchantActor = `merchant-replies-${workspaceId}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: supportActor, displayName: supportActor, role: 'support', status: 'active', invitedBy: 'support-replies-test' })
    await workspaceMembers.upsert({ workspaceId, externalSubject: merchantActor, displayName: merchantActor, role: 'merchant_admin', status: 'active', invitedBy: 'support-replies-test' })
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'support-replies-token': { workspaces: [workspaceId], actor_id: supportActor, roles: ['support'], workbenches: ['workspace'] },
      'merchant-replies-token': { workspaces: [workspaceId], actor_id: merchantActor, roles: ['merchant_admin'], workbenches: ['workspace'] },
    }))
    const base = await start()
    service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `support-replies-store-${workspaceId}`, credentialRef: `vault://support-replies/${workspaceId}` })
    const ticket = await createTicket(base, workspaceId, 'support-replies-token')
    const afterInternal = await comment(base, workspaceId, 'support-replies-token', ticket.id, ticket.revision, 'internal', 'internal investigation details')
    await comment(base, workspaceId, 'support-replies-token', ticket.id, afterInternal.revision, 'customer', 'customer-safe resolution')

    const listed = await call(base, 'merchant-replies-token', workspaceId, 'support.customer.replies.list', { ticket_id: ticket.id })
    expect(listed.response.status, JSON.stringify(listed.body)).toBe(200)
    expect(listed.body.error).toBeNull()
    expect(result(listed.body)).toEqual({
      ticket_id: ticket.id, ticket_number: expect.any(String), subject: '回复可见性测试', status: 'open',
      replies: [{ id: expect.any(String), body: 'customer-safe resolution', created_at: expect.any(String) }],
      next_cursor: null,
    })
    const serialized = JSON.stringify(result(listed.body))
    expect(serialized).not.toContain('internal investigation details')
    expect(serialized).not.toContain('visibility')
    expect(serialized).not.toContain('idempotency_key')
    expect(serialized).not.toContain('actor_id')
  })

  it('fails closed when a ticket belongs to another workspace and supports bounded pagination', async () => {
    const suffix = Date.now()
    const workspaceA = `ws_customer_replies_a_${suffix}`
    const workspaceB = `ws_customer_replies_b_${suffix}`
    const supportActor = `support-replies-${suffix}`
    const merchantActor = `merchant-replies-${suffix}`
    for (const [workspaceId, actor, role] of [[workspaceA, supportActor, 'support'], [workspaceA, merchantActor, 'merchant_admin'], [workspaceB, supportActor, 'support'], [workspaceB, merchantActor, 'merchant_admin']] as const) {
      await workspaceMembers.upsert({ workspaceId, externalSubject: actor, displayName: actor, role, status: 'active', invitedBy: 'support-replies-test' })
    }
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'support-replies-token': { workspaces: [workspaceA, workspaceB], actor_id: supportActor, roles: ['support'], workbenches: ['workspace'] },
      'merchant-replies-token': { workspaces: [workspaceA, workspaceB], actor_id: merchantActor, roles: ['merchant_admin'], workbenches: ['workspace'] },
    }))
    const base = await start()
    for (const workspaceId of [workspaceA, workspaceB]) service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `support-replies-store-${workspaceId}`, credentialRef: `vault://support-replies/${workspaceId}` })
    const ticket = await createTicket(base, workspaceB, 'support-replies-token')
    let revision = ticket.revision
    for (const body of ['reply-1', 'reply-2', 'reply-3']) revision = (await comment(base, workspaceB, 'support-replies-token', ticket.id, revision, 'customer', body)).revision

    const crossWorkspace = await call(base, 'merchant-replies-token', workspaceA, 'support.customer.replies.list', { ticket_id: ticket.id })
    expect(crossWorkspace.response.status).toBe(404)
    expect(crossWorkspace.body.data).toBeNull()

    const firstPage = await call(base, 'merchant-replies-token', workspaceB, 'support.customer.replies.list', { ticket_id: ticket.id, limit: '2' })
    expect(firstPage.response.status, JSON.stringify(firstPage.body)).toBe(200)
    expect((result(firstPage.body) as { replies: Array<{ body: string }>; next_cursor: string | null }).replies.map(reply => reply.body)).toEqual(['reply-1', 'reply-2'])
    expect((result(firstPage.body) as { next_cursor: string | null }).next_cursor).toEqual(expect.any(String))
    const secondPage = await call(base, 'merchant-replies-token', workspaceB, 'support.customer.replies.list', { ticket_id: ticket.id, limit: '2', cursor: (result(firstPage.body) as { next_cursor: string }).next_cursor })
    expect(secondPage.response.status, JSON.stringify(secondPage.body)).toBe(200)
    expect((result(secondPage.body) as { replies: Array<{ body: string }>; next_cursor: string | null }).replies.map(reply => reply.body)).toEqual(['reply-3'])
    expect((result(secondPage.body) as { next_cursor: string | null }).next_cursor).toBeNull()
  })

  it('discovers associated tickets by task or order without exposing internal comments', async () => {
    const workspaceId = `ws_customer_replies_assoc_${Date.now()}`
    const supportActor = `support-assoc-${workspaceId}`
    const merchantActor = `merchant-assoc-${workspaceId}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: supportActor, displayName: supportActor, role: 'support', status: 'active', invitedBy: 'support-replies-test' })
    await workspaceMembers.upsert({ workspaceId, externalSubject: merchantActor, displayName: merchantActor, role: 'merchant_admin', status: 'active', invitedBy: 'support-replies-test' })
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'support-replies-token': { workspaces: [workspaceId], actor_id: supportActor, roles: ['support'], workbenches: ['workspace'] },
      'merchant-replies-token': { workspaces: [workspaceId], actor_id: merchantActor, roles: ['merchant_admin'], workbenches: ['workspace'] },
    }))
    const base = await start()
    service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `support-assoc-store-${workspaceId}`, credentialRef: `vault://support-assoc/${workspaceId}` })
    const taskId = 'task-associated-with-support'
    const ticket = await createTicket(base, workspaceId, 'support-replies-token', { related_task_id: taskId, related_order_id: 'order-associated-with-support' })
    const internal = await comment(base, workspaceId, 'support-replies-token', ticket.id, ticket.revision, 'internal', 'do not expose this')
    await comment(base, workspaceId, 'support-replies-token', ticket.id, internal.revision, 'customer', '请重新授权店铺后重试')

    const discovered = await call(base, 'merchant-replies-token', workspaceId, 'support.customer.replies.list', { related_task_id: taskId })
    expect(discovered.response.status, JSON.stringify(discovered.body)).toBe(200)
    expect(result(discovered.body)).toEqual({
      tickets: [{ ticket_id: ticket.id, ticket_number: expect.any(String), subject: '回复可见性测试', status: 'open', related_task_id: taskId, related_order_id: 'order-associated-with-support', replies: [{ id: expect.any(String), body: '请重新授权店铺后重试', created_at: expect.any(String) }], next_cursor: null }],
      next_cursor: null,
    })
    expect(JSON.stringify(result(discovered.body))).not.toContain('do not expose this')

    const byOrder = await call(base, 'merchant-replies-token', workspaceId, 'support.customer.replies.list', { related_order_id: 'order-associated-with-support' })
    expect((result(byOrder.body) as { tickets: Array<{ ticket_id: string }> }).tickets.map(item => item.ticket_id)).toEqual([ticket.id])
  })

  it('paginates associated tickets instead of silently truncating after twenty', async () => {
    const workspaceId = `ws_customer_replies_ticket_pages_${Date.now()}`
    const supportActor = `support-pages-${workspaceId}`
    const merchantActor = `merchant-pages-${workspaceId}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: supportActor, displayName: supportActor, role: 'support', status: 'active', invitedBy: 'support-replies-test' })
    await workspaceMembers.upsert({ workspaceId, externalSubject: merchantActor, displayName: merchantActor, role: 'merchant_admin', status: 'active', invitedBy: 'support-replies-test' })
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'support-replies-token': { workspaces: [workspaceId], actor_id: supportActor, roles: ['support'], workbenches: ['workspace'] },
      'merchant-replies-token': { workspaces: [workspaceId], actor_id: merchantActor, roles: ['merchant_admin'], workbenches: ['workspace'] },
    }))
    const base = await start()
    service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `support-pages-store-${workspaceId}`, credentialRef: `vault://support-pages/${workspaceId}` })
    for (let index = 0; index < 21; index += 1) await createTicket(base, workspaceId, 'support-replies-token', { related_task_id: 'task-with-many-tickets' }, String(index))

    const first = await call(base, 'merchant-replies-token', workspaceId, 'support.customer.replies.list', { related_task_id: 'task-with-many-tickets', limit: '20' })
    expect(first.response.status, JSON.stringify(first.body)).toBe(200)
    const firstResult = result(first.body) as { tickets: Array<{ ticket_id: string }>; next_cursor: string | null }
    expect(firstResult.tickets).toHaveLength(20)
    expect(firstResult.next_cursor).toEqual(expect.any(String))
    const second = await call(base, 'merchant-replies-token', workspaceId, 'support.customer.replies.list', { related_task_id: 'task-with-many-tickets', limit: '20', cursor: firstResult.next_cursor })
    expect(second.response.status, JSON.stringify(second.body)).toBe(200)
    const secondResult = result(second.body) as { tickets: Array<{ ticket_id: string }>; next_cursor: string | null }
    expect(secondResult.tickets).toHaveLength(1)
    expect(secondResult.next_cursor).toBeNull()
    const firstIds = new Set(firstResult.tickets.map(ticket => ticket.ticket_id))
    expect(secondResult.tickets.filter(ticket => firstIds.has(ticket.ticket_id))).toHaveLength(0)
  })
})
