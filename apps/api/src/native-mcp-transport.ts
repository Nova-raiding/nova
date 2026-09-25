import type { IncomingMessage, ServerResponse } from 'node:http'
import { DomainError } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import { nativeMcpTools as listNativeMcpTools } from './native-mcp-tools.js'

type JsonObject = Record<string, unknown>

export const nativeMcpRequests = new WeakSet<IncomingMessage>()
export const nativeMcpRequestIds = new WeakMap<IncomingMessage, string | number | null>()
const MCP_PROTOCOL_VERSION = '2025-06-18'

function isNativeMcpMethod(method: unknown): method is 'initialize' | 'tools/list' | 'tools/call' {
  return method === 'initialize' || method === 'tools/list' || method === 'tools/call'
}

export function isNativeMcpTransport(req: IncomingMessage, method: unknown, header: (req: IncomingMessage, name: string) => string | undefined) {
  if (isNativeMcpMethod(method)) return true
  return (header(req, 'accept') ?? '').split(',').some(value => value.trim().toLowerCase() === 'text/event-stream')
}

export function nativeMcpErrorCode(error: unknown) {
  if (error instanceof DomainError) {
    if (error.code === 'MCP_NATIVE_INVALID_REQUEST') return -32600
    if (error.code === ERROR_CODES.MCP_METHOD_NOT_FOUND) return -32601
    if (error.code === ERROR_CODES.INVALID_REQUEST) return -32602
    if (error.code === ERROR_CODES.UNAUTHENTICATED || error.status === 401) return -32001
  }
  return -32603
}

export async function routeNativeMcp(req: IncomingMessage, res: ServerResponse, input: JsonObject, deps: {
  send: (res: ServerResponse, status: number, payload: unknown, req: IncomingMessage) => void
  dispatch: (req: IncomingMessage, res: ServerResponse, input: JsonObject, transport: 'native') => Promise<unknown>
  isToolEnabled: (method: string) => boolean
  paymentReady: () => boolean
}) {
  const id = Object.prototype.hasOwnProperty.call(input, 'id') && (typeof input.id === 'string' || typeof input.id === 'number' || input.id === null)
    ? input.id as string | number | null
    : null
  nativeMcpRequests.add(req)
  nativeMcpRequestIds.set(req, id)
  if (input.jsonrpc !== '2.0' || !Object.prototype.hasOwnProperty.call(input, 'id') || typeof input.method !== 'string' || !input.method.trim()) {
    throw new DomainError('MCP_NATIVE_INVALID_REQUEST', '原生 MCP JSON-RPC 请求无效', 400)
  }
  if (!isNativeMcpMethod(input.method)) throw new DomainError(ERROR_CODES.MCP_METHOD_NOT_FOUND, `不支持的原生 MCP 方法: ${input.method}`, 404)
  if (input.method === 'initialize') {
    return deps.send(res, 200, { jsonrpc: '2.0', id, result: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'merchant-marketing', version: process.env.MCP_VERSION?.trim() || 'development' },
    } }, req)
  }
  if (input.method === 'tools/list') {
    return deps.send(res, 200, { jsonrpc: '2.0', id, result: { tools: listNativeMcpTools(deps.paymentReady) } }, req)
  }
  const params = input.params
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'tools/call params 必须是 JSON 对象', 400)
  const name = (params as Record<string, unknown>).name
  if (typeof name !== 'string' || !name.trim()) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'tools/call 必须提供工具名称', 400)
  if (!deps.isToolEnabled(name)) {
    throw new DomainError(ERROR_CODES.MCP_METHOD_NOT_FOUND, '原生 MCP 工具不存在或不属于 ChatGPT 商家插件', 404)
  }
  const args = (params as Record<string, unknown>).arguments
  if (args !== undefined && (!args || typeof args !== 'object' || Array.isArray(args))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'tools/call arguments 必须是 JSON 对象', 400)
  return deps.dispatch(req, res, { jsonrpc: '2.0', id, method: name, params: (args ?? {}) as JsonObject }, 'native')
}

