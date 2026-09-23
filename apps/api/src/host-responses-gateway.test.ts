import { describe, expect, it, vi } from 'vitest'
import { handleHostResponses, type HostResponsesDependencies } from './host-responses-gateway.js'

const token = 'host-workspace-token-1234567890'
function request(body: unknown, auth = `Bearer ${token}`): Request {
  return new Request('https://api.example/v1/responses', { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) })
}
function body(overrides: Record<string, unknown> = {}) {
  return { model: 'merchant-host', input: 'hello', stream: true, store: false, max_output_tokens: 100, ...overrides }
}
function sse(events: string[]): Response {
  return new Response(events.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
function completed(usage: Record<string, unknown> = { input_tokens: 3, output_tokens: 2, total_tokens: 5 }): string {
  return `event: response.completed\ndata: ${JSON.stringify({ response: { id: 'resp-1', model: 'relay-chat', usage } })}\n\n`
}
function harness(upstream = sse(['event: response.created\ndata: {"response":{"id":"resp-1"}}\n\n', completed()])) {
  const authenticate = vi.fn(async () => ({ workspaceId: 'ws_one', actorId: 'user_1', audience: 'host-responses' as const, expiresAt: Date.now() + 60_000 }))
  const reserve = vi.fn(async () => ({ id: 'reservation-1', workspaceId: 'ws_one', maxPoints: 100n }))
  const settle = vi.fn(async () => {})
  const hold = vi.fn(async () => {})
  const fetchUpstream = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => upstream)
  const deps: HostResponsesDependencies = {
    authenticate, reserve, settle, hold, fetchUpstream: fetchUpstream as typeof fetch,
    relayApiKey: 'server-secret-only', relayBaseUrl: 'https://relay.example/v1', models: { 'merchant-host': 'relay-chat' },
  }
  return { deps, authenticate, reserve, settle, hold, fetchUpstream }
}

describe('host Responses gateway isolated transport', () => {
  it('reserves workspace points before calling relay and settles observed usage once', async () => {
    const h = harness()
    const result = await handleHostResponses(request(body()), h.deps)
    expect(result.status).toBe(200)
    expect(await result.text()).toContain('event: response.completed')
    expect(h.reserve).toHaveBeenCalledWith(expect.objectContaining({ model: 'merchant-host', maxOutputTokens: 100, credential: expect.objectContaining({ workspaceId: 'ws_one' }) }))
    expect(h.fetchUpstream).toHaveBeenCalledOnce()
    expect(h.reserve.mock.invocationCallOrder[0]).toBeLessThan(h.fetchUpstream.mock.invocationCallOrder[0]!)
    const [, init] = h.fetchUpstream.mock.calls[0]!
    if (!init) throw new Error('upstream init missing')
    expect(init.headers).toMatchObject({ authorization: 'Bearer server-secret-only' })
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'relay-chat', input: 'hello' })
    expect(h.settle).toHaveBeenCalledWith({ reservation: { id: 'reservation-1', workspaceId: 'ws_one', maxPoints: 100n }, model: 'merchant-host', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, providerRequestId: 'resp-1' } })
    expect(h.hold).not.toHaveBeenCalled()
  })

  it('rejects wrong audience, expired token, unapproved model, and zero points without upstream calls', async () => {
    const h = harness()
    h.authenticate.mockResolvedValueOnce({ workspaceId: 'ws_one', actorId: 'user_1', audience: 'host-responses', expiresAt: Date.now() - 1 })
    expect((await handleHostResponses(request(body()), h.deps)).status).toBe(401)
    expect((await handleHostResponses(request(body({ model: 'unapproved' })), h.deps)).status).toBe(400)
    h.reserve.mockRejectedValueOnce(new Error('NO_POINTS'))
    expect((await handleHostResponses(request(body()), h.deps)).status).toBe(402)
    expect(h.fetchUpstream).not.toHaveBeenCalled()
    h.deps.authenticate = async () => ({ workspaceId: 'ws_one', actorId: 'user_1', audience: '/mcp' as 'host-responses', expiresAt: Date.now() + 60_000 })
    expect((await handleHostResponses(request(body()), h.deps)).status).toBe(401)
  })

  it('fails closed when relay configuration or bounded output is missing', async () => {
    const h = harness()
    h.deps.relayApiKey = ''
    expect((await handleHostResponses(request(body()), h.deps)).status).toBe(503)
    h.deps.relayApiKey = 'server-secret-only'
    expect((await handleHostResponses(request(body({ max_output_tokens: undefined })), h.deps)).status).toBe(400)
    expect((await handleHostResponses(request(body({ store: true })), h.deps)).status).toBe(400)
    expect((await handleHostResponses(request(body({ input: [{ type: 'input_image', image_url: 'data:image/png;base64,abc' }] })), h.deps)).status).toBe(400)
    expect((await handleHostResponses(request(body({ tools: [{ type: 'web_search' }] })), h.deps)).status).toBe(400)
    expect(h.reserve).not.toHaveBeenCalled()
  })

  it('explicitly rejects the observed Codex CLI default request until array and tool pricing is implemented', async () => {
    const h = harness()
    const observedCliShape = {
      model: 'merchant-host', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      instructions: 'assist', stream: true, store: false, parallel_tool_calls: true,
      tool_choice: 'auto', tools: [{ type: 'function', name: 'test', parameters: {} }],
      include: ['reasoning.encrypted_content'], reasoning: { effort: 'medium' },
      text: { verbosity: 'medium' }, client_metadata: { session_id: 'synthetic' },
    }
    const response = await handleHostResponses(request(observedCliShape), h.deps)
    expect(response.status).toBe(400)
    expect(h.reserve).not.toHaveBeenCalled()
    expect(h.fetchUpstream).not.toHaveBeenCalled()
  })

  it('rejects an oversized body before reservation or upstream access', async () => {
    const h = harness()
    const response = await handleHostResponses(request(body({ input: 'x'.repeat(1_048_576) })), h.deps)
    expect(response.status).toBe(413)
    expect(h.reserve).not.toHaveBeenCalled()
    expect(h.fetchUpstream).not.toHaveBeenCalled()
  })

  it('holds the reservation on an incomplete stream or missing usage', async () => {
    const h = harness(sse(['event: response.created\ndata: {"response":{"id":"resp-1"}}\n\n']))
    const response = await handleHostResponses(request(body()), h.deps)
    expect(await response.text()).toContain('HOST_OUTCOME_UNCONFIRMED')
    expect(h.hold).toHaveBeenCalledWith({ reservation: expect.objectContaining({ id: 'reservation-1' }), reason: 'INCOMPLETE_RESPONSE' })
    expect(h.settle).not.toHaveBeenCalled()

    const h2 = harness(sse([completed({ input_tokens: 3, output_tokens: 2 })]))
    const response2 = await handleHostResponses(request(body()), h2.deps)
    expect(await response2.text()).toContain('HOST_OUTCOME_UNCONFIRMED')
    expect(h2.hold).toHaveBeenCalledWith({ reservation: expect.any(Object), reason: 'MISSING_USAGE' })
    expect(h2.settle).not.toHaveBeenCalled()
  })

  it('accepts fragmented SSE comment keepalives before observed completion', async () => {
    const encoder = new TextEncoder()
    const chunks = [': relay keep', 'alive\n\n', 'event: response.created\ndata: {"response":{"id":"resp-1"}}\n\n', completed()]
    const upstream = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    const h = harness(upstream)
    const result = await handleHostResponses(request(body()), h.deps)
    expect(result.status).toBe(200)
    const events = await result.text()
    expect(events).toContain('event: response.completed')
    expect(events).not.toContain('HOST_OUTCOME_UNCONFIRMED')
    expect(h.settle).toHaveBeenCalledOnce()
    expect(h.hold).not.toHaveBeenCalled()
  })

  it('does not refund an ambiguous upstream rejection and never forwards its raw error', async () => {
    const h = harness(new Response('secret upstream failure', { status: 500, headers: { 'content-type': 'text/plain' } }))
    const response = await handleHostResponses(request(body()), h.deps)
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('secret upstream failure')
    expect(h.hold).toHaveBeenCalledWith({ reservation: expect.any(Object), reason: 'UPSTREAM_HTTP_500' })
    expect(h.settle).not.toHaveBeenCalled()
  })

  it('withholds completion and retains the reservation when actual usage settlement fails', async () => {
    const h = harness()
    h.settle.mockRejectedValueOnce(new Error('database unavailable'))
    const response = await handleHostResponses(request(body()), h.deps)
    const events = await response.text()
    expect(events).not.toContain('event: response.completed')
    expect(events).toContain('HOST_OUTCOME_UNCONFIRMED')
    expect(h.hold).toHaveBeenCalledWith({ reservation: expect.any(Object), reason: 'database unavailable', providerRequestId: 'resp-1' })
  })
})
