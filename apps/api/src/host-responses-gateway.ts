/**
 * Responses-compatible host transport. This module is intentionally not mounted:
 * the server must supply durable, workspace-scoped auth and point reservations.
 * Current text-only request constraints reject the observed Codex CLI 0.155.1
 * default request (array input, tools, no max_output_tokens). This is a safety
 * scaffold, not an installable or production-ready host gateway.
 * Never pass a business relay credential or an MCP token to the desktop client.
 */
export type HostCredential = {
  workspaceId: string
  actorId: string
  audience: 'host-responses'
  expiresAt: number
}

export type HostReservation = { id: string; workspaceId: string; maxPoints: bigint }
export type HostUsage = { inputTokens: number; outputTokens: number; totalTokens: number; providerRequestId: string }

export type HostResponsesDependencies = {
  /** Must validate a dedicated, short-lived credential and current workspace membership. */
  authenticate(token: string): Promise<HostCredential | null>
  /** Must atomically recheck membership, approved rate, budget, and available points before reserving. */
  reserve(input: { credential: HostCredential; model: string; inputBytes: number; maxOutputTokens: number }): Promise<HostReservation>
  /** Must durably charge actual usage and release only the unused reserved amount. */
  settle(input: { reservation: HostReservation; model: string; usage: HostUsage }): Promise<void>
  /** Must retain the full reservation for reconciliation; it must never refund an ambiguous call. */
  hold(input: { reservation: HostReservation; reason: string; providerRequestId?: string }): Promise<void>
  /** Server-side secret only. Never use the client token as the upstream key. */
  relayApiKey: string
  relayBaseUrl: string
  /** Public host alias -> approved relay model ID. Only entries here are callable. */
  models: Readonly<Record<string, string>>
  fetchUpstream?: typeof fetch
  now?: () => number
}

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
const MAX_BODY_BYTES = 1_048_576
const MAX_OUTPUT_TOKENS = 16_384
const MAX_EVENT_BYTES = 262_144

function error(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { code, message: code } }), { status, headers: jsonHeaders })
}

function configuredRelayUrl(base: string): URL | null {
  try {
    const url = new URL(base)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname || !/^\/(?:v1)?\/?$/u.test(url.pathname)) return null
    url.pathname = '/v1/responses'
    return url
  } catch { return null }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function observedUsage(value: unknown, model: string): HostUsage | null {
  if (!isRecord(value) || value.model !== model || typeof value.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/u.test(value.id)) return null
  const usage = value.usage
  if (!isRecord(usage)) return null
  const inputTokens = usage.input_tokens, outputTokens = usage.output_tokens, totalTokens = usage.total_tokens
  if (![inputTokens, outputTokens, totalTokens].every(number => Number.isSafeInteger(number) && Number(number) >= 0)) return null
  if (Number(inputTokens) + Number(outputTokens) !== totalTokens) return null
  return { inputTokens: Number(inputTokens), outputTokens: Number(outputTokens), totalTokens: Number(totalTokens), providerRequestId: value.id }
}

function parseEvent(frame: string): { event: string; data: unknown } | null {
  let event = ''
  const data: string[] = []
  for (const line of frame.split(/\r?\n/u)) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
  }
  if (!event || data.length === 0) return null
  try { return { event, data: JSON.parse(data.join('\n')) } } catch { return null }
}

function acceptedBody(raw: string, models: Readonly<Record<string, string>>): { model: string; upstreamModel: string; body: string; maxOutputTokens: number } | null {
  let body: unknown
  try { body = JSON.parse(raw) } catch { return null }
  if (!isRecord(body) || typeof body.model !== 'string' || !Object.hasOwn(models, body.model)) return null
  const upstreamModel = models[body.model]
  if (typeof upstreamModel !== 'string' || !/^[A-Za-z0-9_.:/-]{1,128}$/u.test(upstreamModel)) return null
  // This transport only prices text. Rich input parts and hosted tools need a
  // separate quote contract; forwarding them under a text reservation is unsafe.
  const allowed = new Set(['model', 'input', 'instructions', 'stream', 'store', 'max_output_tokens', 'temperature', 'top_p', 'reasoning', 'text'])
  if (Object.keys(body).some(key => !allowed.has(key))) return null
  if (body.stream !== true || body.store !== false || typeof body.input !== 'string') return null
  if (body.instructions !== undefined && typeof body.instructions !== 'string') return null
  if (!Number.isSafeInteger(body.max_output_tokens) || Number(body.max_output_tokens) < 1 || Number(body.max_output_tokens) > MAX_OUTPUT_TOKENS) return null
  // Fix the billed model on the server; never trust a client-supplied relay ID.
  return { model: body.model, upstreamModel, body: JSON.stringify({ ...body, model: upstreamModel }), maxOutputTokens: Number(body.max_output_tokens) }
}

async function readBoundedBody(request: Request): Promise<string | null> {
  if (!request.body) return ''
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > MAX_BODY_BYTES) { await reader.cancel(); return null }
      chunks.push(part.value)
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } finally { reader.releaseLock() }
}

/** Framework-neutral handler; mounting it requires a separate security review. */
export async function handleHostResponses(request: Request, deps: HostResponsesDependencies): Promise<Response> {
  if (request.method !== 'POST') return error(405, 'METHOD_NOT_ALLOWED')
  const relayUrl = configuredRelayUrl(deps.relayBaseUrl)
  if (!relayUrl || !deps.relayApiKey || /^(?:replace|placeholder|your[-_])/iu.test(deps.relayApiKey)) return error(503, 'HOST_RELAY_NOT_CONFIGURED')
  const authorization = request.headers.get('authorization') ?? ''
  const bearer = /^Bearer ([A-Za-z0-9._~-]{20,4096})$/u.exec(authorization)?.[1]
  if (!bearer) return error(401, 'HOST_AUTH_REQUIRED')
  let credential: HostCredential | null
  try { credential = await deps.authenticate(bearer) } catch { return error(503, 'HOST_AUTH_UNAVAILABLE') }
  if (!credential || credential.audience !== 'host-responses' || !credential.workspaceId || !credential.actorId || !Number.isFinite(credential.expiresAt) || credential.expiresAt <= (deps.now?.() ?? Date.now()) || credential.expiresAt > (deps.now?.() ?? Date.now()) + 15 * 60_000) return error(401, 'HOST_AUTH_INVALID')
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return error(415, 'UNSUPPORTED_MEDIA_TYPE')
  const declaredLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return error(413, 'REQUEST_TOO_LARGE')
  let raw: string | null
  try { raw = await readBoundedBody(request) } catch { return error(400, 'INVALID_REQUEST') }
  if (raw === null) return error(413, 'REQUEST_TOO_LARGE')
  const inputBytes = Buffer.byteLength(raw)
  if (inputBytes > MAX_BODY_BYTES) return error(413, 'REQUEST_TOO_LARGE')
  const parsed = acceptedBody(raw, deps.models)
  if (!parsed) return error(400, 'UNSUPPORTED_RESPONSES_REQUEST')

  let reservation: HostReservation
  try { reservation = await deps.reserve({ credential, model: parsed.model, inputBytes, maxOutputTokens: parsed.maxOutputTokens }) }
  catch { return error(402, 'HOST_POINTS_OR_RATE_UNAVAILABLE') }
  if (!reservation?.id || reservation.workspaceId !== credential.workspaceId || typeof reservation.maxPoints !== 'bigint' || reservation.maxPoints <= 0n) return error(503, 'HOST_RESERVATION_INVALID')

  let upstream: Response
  try {
    upstream = await (deps.fetchUpstream ?? fetch)(relayUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${deps.relayApiKey}`, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: parsed.body,
      redirect: 'error',
    })
  } catch {
    await deps.hold({ reservation, reason: 'UPSTREAM_OUTCOME_UNKNOWN' })
    return error(502, 'HOST_RELAY_UNAVAILABLE')
  }
  if (!upstream.ok || !upstream.body || !upstream.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
    await deps.hold({ reservation, reason: `UPSTREAM_HTTP_${upstream.status}` })
    return error(502, 'HOST_RELAY_ERROR')
  }

  const reader = upstream.body.getReader()
  let clientGone = false
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder(), decoder = new TextDecoder()
      let pending = '', completed = false, providerRequestId: string | undefined
      const emit = (frame: string) => { if (!clientGone) { try { controller.enqueue(encoder.encode(frame)) } catch { clientGone = true } } }
      try {
        while (!completed) {
          const chunk = await reader.read()
          if (chunk.done) break
          pending += decoder.decode(chunk.value, { stream: true })
          let boundary: RegExpExecArray | null
          while ((boundary = /\r?\n\r?\n/u.exec(pending)) !== null) {
            const frame = pending.slice(0, boundary.index)
            pending = pending.slice(boundary.index + boundary[0].length)
            if (Buffer.byteLength(frame) > MAX_EVENT_BYTES) throw new Error('EVENT_TOO_LARGE')
            const event = parseEvent(frame)
            if (!event) throw new Error('INVALID_EVENT')
            if (event.event === 'response.completed') {
              const response = isRecord(event.data) ? event.data.response : undefined
              const usage = observedUsage(response, parsed.upstreamModel)
              if (!usage) throw new Error('MISSING_USAGE')
              providerRequestId = usage.providerRequestId
              await deps.settle({ reservation, model: parsed.model, usage })
              completed = true
            }
            emit(`${frame}\n\n`)
            if (completed) break
          }
          if (Buffer.byteLength(pending) > MAX_EVENT_BYTES) throw new Error('EVENT_TOO_LARGE')
        }
        if (!completed) throw new Error('INCOMPLETE_RESPONSE')
      } catch (cause) {
        try { await deps.hold({ reservation, reason: cause instanceof Error ? cause.message : 'STREAM_ERROR', ...(providerRequestId ? { providerRequestId } : {}) }) } catch { /* durable hold failure requires external alert */ }
        emit('event: error\ndata: {"error":{"code":"HOST_OUTCOME_UNCONFIRMED"}}\n\n')
      } finally {
        try { await reader.cancel() } catch { /* upstream already closed */ }
        if (!clientGone) { try { controller.close() } catch { /* client closed */ } }
      }
    },
    cancel() { clientGone = true /* Continue reading upstream to capture usage and settle. */ },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' } })
}
