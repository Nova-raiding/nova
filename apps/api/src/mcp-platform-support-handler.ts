import type { IncomingMessage } from 'node:http'
import { DomainError } from '../../../packages/application/src/service.js'
import type { SupportTicketPageCursor, SupportTicketStatus } from '../../../packages/contracts/src/ops/support.js'
import type { SupportRepository } from '../../../packages/persistence/src/support-repository.js'
import { SupportService, type SupportAuthorizationContext } from './ops/support-service.js'
import { assertBoundedOpsParams, optionalNumberValue, optionalStringValue, requiredStringValue, structuredValue } from './ops-params.js'
import { redactSupportCredentials } from './merchant-support-request.js'

export const MCP_PLATFORM_SUPPORT_METHODS = new Set([
  'ops.support.platform.tickets.list', 'ops.support.platform.ticket.get', 'ops.support.platform.ticket.comment',
])
export interface McpPlatformSupportDependencies {
  repository: SupportRepository | undefined
  /** Verifies actual platform workbench and platform operator role, never a caller role/header claim. */
  requirePlatformOperations(req: IncomingMessage): unknown | Promise<unknown>
  /** Independent central grant for this exact platform method and explicit target. */
  requireSupportCapability(req: IncomingMessage, targetWorkspaceId: string, capability: 'support.ticket.read' | 'support.ticket.update'): unknown | Promise<unknown>
  requireTargetWorkspace(workspaceId: string): unknown | Promise<unknown>
  requestActor(req: IncomingMessage): string
  invokeOpsDomain<T>(operation: () => Promise<T>): Promise<T>
}
export async function handleMcpPlatformSupport(method: string, params: Record<string, unknown>, req: IncomingMessage, deps: McpPlatformSupportDependencies): Promise<unknown> {
  if (!MCP_PLATFORM_SUPPORT_METHODS.has(method)) throw new DomainError('INVALID_REQUEST', '未知平台客服方法', 400)
  await deps.requirePlatformOperations(req)
  assertBoundedOpsParams(params)
  const allowed = method.endsWith('tickets.list') ? ['target_workspace_id', 'status', 'limit', 'cursor_json']
    : method.endsWith('ticket.get') ? ['target_workspace_id', 'ticket_id']
      : ['target_workspace_id', 'ticket_id', 'body', 'visibility', 'expected_revision', 'idempotency_key']
  if (Object.keys(params).some(key => !allowed.includes(key))) throw new DomainError('INVALID_REQUEST', '平台客服参数不接受身份、角色或隐式工作区，请明确目标企业', 400)
  const workspaceId = requiredStringValue(params, 'target_workspace_id')
  if (!/^[a-z0-9][a-z0-9_.:-]{0,255}$/iu.test(workspaceId)) throw new DomainError('INVALID_REQUEST', '目标企业标识无效', 400)
  const comment = method.endsWith('ticket.comment')
  await deps.requireSupportCapability(req, workspaceId, comment ? 'support.ticket.update' : 'support.ticket.read')
  await deps.requireTargetWorkspace(workspaceId)
  const actorId = deps.requestActor(req)
  if (!actorId?.trim()) throw new DomainError('FORBIDDEN', '平台客服操作需要已验证的运营身份', 403)
  if (!deps.repository) throw new DomainError('SUPPORT_REPOSITORY_UNAVAILABLE', '客服工单仓储未配置', 503)
  const context: SupportAuthorizationContext = { actorId, role: 'platform_ops', workspaceId,
    permissions: comment ? ['support.ticket.comment'] : ['support.ticket.read'] }
  const service = new SupportService(deps.repository)
  if (method.endsWith('tickets.list')) {
    const rawCursor = structuredValue(params, 'cursor_json')
    let cursor: SupportTicketPageCursor | undefined
    if (rawCursor !== undefined) {
      if (!rawCursor || typeof rawCursor !== 'object' || Array.isArray(rawCursor) || Object.keys(rawCursor).some(key => !['id', 'createdAt', 'created_at'].includes(key))) throw new DomainError('INVALID_REQUEST', 'cursor_json 必须为分页游标对象', 400)
      const value = rawCursor as Record<string, unknown>
      if (typeof value.id !== 'string' || typeof (value.createdAt ?? value.created_at) !== 'string') throw new DomainError('INVALID_REQUEST', '分页游标字段无效', 400)
      cursor = { id: value.id, createdAt: (value.createdAt ?? value.created_at) as string }
    }
    return deps.invokeOpsDomain(() => service.list(context, { workspaceId, limit: optionalNumberValue(params, 'limit') ?? 50,
      ...(optionalStringValue(params, 'status') ? { status: optionalStringValue(params, 'status') as SupportTicketStatus } : {}), ...(cursor ? { cursor } : {}) }))
  }
  const ticketId = requiredStringValue(params, 'ticket_id')
  if (!comment) return deps.invokeOpsDomain(() => service.get(context, workspaceId, ticketId))
  const reply = requiredStringValue(params, 'body')
  const visibility = requiredStringValue(params, 'visibility')
  const expectedRevision = optionalNumberValue(params, 'expected_revision') ?? 0
  const idempotencyKey = requiredStringValue(params, 'idempotency_key')
  return deps.invokeOpsDomain(() => service.comment(context, { workspaceId, ticketId,
    body: redactSupportCredentials(reply), visibility: visibility as 'customer' | 'internal', expectedRevision, idempotencyKey }))
}
