import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { DomainError } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import { isNativeMcpTransport, nativeMcpRequestIds, nativeMcpRequests, routeNativeMcp } from './native-mcp-transport.js'

function request() {
  return {} as IncomingMessage
}

function response() {
  return { statusCode: 200, end: vi.fn() } as unknown as ServerResponse
}

function dependencies() {
  return {
    send: vi.fn(),
    dispatch: vi.fn(async () => ({ ok: true })),
    isToolEnabled: vi.fn((name: string) => name === 'catalog.search'),
    paymentReady: vi.fn(() => true),
  }
}

describe('native MCP transport', () => {
  it('selects native transport for native methods or an event-stream Accept value', () => {
    const req = request()
    const header = vi.fn((_request: IncomingMessage, name: string) => name === 'accept' ? 'application/json, Text/Event-Stream' : undefined)

    expect(isNativeMcpTransport(req, 'initialize', header)).toBe(true)
    expect(isNativeMcpTransport(req, 'tools/list', header)).toBe(true)
    expect(isNativeMcpTransport(req, 'unrelated/method', header)).toBe(true)
    expect(header).toHaveBeenCalledWith(req, 'accept')
    expect(isNativeMcpTransport(req, 'unrelated/method', () => 'application/json')).toBe(false)
    expect(isNativeMcpTransport(req, 'unrelated/method', () => 'text/event-streaming')).toBe(false)
  })

  it.each([
    { name: 'object id', id: {} },
    { name: 'array id', id: [] },
    { name: 'infinite id', id: Number.POSITIVE_INFINITY },
    { name: 'NaN id', id: Number.NaN },
  ])('rejects an invalid request id ($name)', async ({ id }) => {
    const req = request()
    await expect(routeNativeMcp(req, response(), { jsonrpc: '2.0', id, method: 'tools/list' }, dependencies()))
      .rejects.toMatchObject({ code: 'MCP_NATIVE_INVALID_REQUEST' })
    expect(nativeMcpRequests.has(req)).toBe(true)
    expect(nativeMcpRequestIds.get(req)).toBeNull()
  })

  it.each([null, [], 'bad'])('rejects notification params that are not an object: %j', async params => {
    const res = response()
    const deps = dependencies()
    await expect(routeNativeMcp(request(), res, { jsonrpc: '2.0', method: 'notifications/initialized', params }, deps))
      .rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST })
    expect(res.end).not.toHaveBeenCalled()
    expect(deps.send).not.toHaveBeenCalled()
  })

  it('accepts an initialized notification without an id and ends with 202', async () => {
    const req = request()
    const res = response()
    await routeNativeMcp(req, res, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, dependencies())
    expect(res.statusCode).toBe(202)
    expect(res.end).toHaveBeenCalledOnce()
    expect(nativeMcpRequestIds.get(req)).toBeNull()
  })

  it.each([
    { name: 'missing params', params: undefined },
    { name: 'array params', params: [] },
    { name: 'null params', params: null },
    { name: 'missing tool name', params: { arguments: {} } },
  ])('rejects invalid tools/call params ($name)', async ({ params }) => {
    const deps = dependencies()
    await expect(routeNativeMcp(request(), response(), { jsonrpc: '2.0', id: 4, method: 'tools/call', params }, deps))
      .rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST })
    expect(deps.dispatch).not.toHaveBeenCalled()
  })

  it.each([null, [], 'bad'])('rejects non-object tools/call arguments: %j', async args => {
    const deps = dependencies()
    await expect(routeNativeMcp(request(), response(), {
      jsonrpc: '2.0', id: 'call-1', method: 'tools/call', params: { name: 'catalog.search', arguments: args },
    }, deps)).rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST })
    expect(deps.dispatch).not.toHaveBeenCalled()
  })

  it('dispatches enabled tools with object arguments and the native transport marker', async () => {
    const req = request()
    const res = response()
    const deps = dependencies()
    await routeNativeMcp(req, res, {
      jsonrpc: '2.0', id: 'call-2', method: 'tools/call', params: { name: 'catalog.search', arguments: { query: 'shoes' } },
    }, deps)

    expect(deps.dispatch).toHaveBeenCalledWith(req, res, {
      jsonrpc: '2.0', id: 'call-2', method: 'catalog.search', params: { query: 'shoes' },
    }, 'native')
  })

  it('dispatches omitted arguments as an empty object, matching the stdio MCP contract', async () => {
    const req = request()
    const res = response()
    const deps = dependencies()
    await routeNativeMcp(req, res, {
      jsonrpc: '2.0', id: 'call-no-arguments', method: 'tools/call', params: { name: 'catalog.search' },
    }, deps)

    expect(deps.dispatch).toHaveBeenCalledWith(req, res, {
      jsonrpc: '2.0', id: 'call-no-arguments', method: 'catalog.search', params: {},
    }, 'native')
  })

  it('rejects disabled tools without dispatching', async () => {
    const deps = dependencies()
    deps.isToolEnabled.mockReturnValue(false)
    await expect(routeNativeMcp(request(), response(), {
      jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'catalog.delete', arguments: {} },
    }, deps)).rejects.toBeInstanceOf(DomainError)
    expect(deps.dispatch).not.toHaveBeenCalled()
  })
})
