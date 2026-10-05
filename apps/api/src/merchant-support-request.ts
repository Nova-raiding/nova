import type { SupportRepository, SupportTicket } from '../../../packages/persistence/src/support-repository.js'
import { DomainError } from '../../../packages/application/src/service.js'
import type { MerchantSupportRequestReceipt, MerchantSupportRequestView } from '../../../packages/contracts/src/merchant-support-request.js'

/** Construct only after session authentication and active workspace membership. Never from request body. */
export interface MerchantSupportContext {
  workspaceId: string
  actorId: string
  customerId: string
  customerName: string
}
const invalid = () => new DomainError('SUPPORT_REQUEST_INVALID', '请填写问题说明和脱敏排障标识，不要提交密码、令牌或付款凭证', 400)
function contextVerified(context: MerchantSupportContext) {
  if ([context.workspaceId, context.actorId, context.customerId, context.customerName].some(value => !value?.trim())) throw new DomainError('SUPPORT_REQUEST_FORBIDDEN', '需要已验证的账号和当前企业成员身份', 403)
}
function text(value: unknown, min: number, max: number) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) throw invalid()
  return value.trim()
}
export function redactSupportCredentials(value: string): string {
  return value.replace(/\bBearer\s+[a-z0-9._~+/=-]+/giu, 'Bearer [已脱敏]')
    .replace(/\b(password|passwd|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret)\s*[:=]\s*[^\s,;]+/giu, '$1=[已脱敏]')
    .replace(/([?&#](?:token|key|password|secret)=)[^\s&#]+/giu, '$1[已脱敏]')
}
function receipt(ticket: SupportTicket, replayed: boolean): MerchantSupportRequestReceipt {
  return { ticket_id: ticket.id, ticket_number: ticket.ticketNumber, status: ticket.status, replayed,
    replies_path: `/v1/support/requests/${ticket.id}`, submitted: true }
}
export async function submitMerchantSupportRequest(repository: SupportRepository | undefined, context: MerchantSupportContext, body: Record<string, unknown>) {
  contextVerified(context)
  if (!repository) throw new DomainError('SUPPORT_REPOSITORY_UNAVAILABLE', '支持登记仓储未配置，请联系安装或运营负责人配置项目内支持入口', 503)
  if (Object.keys(body).some(key => !['subject', 'message', 'idempotency_key', 'request_id', 'trace_id', 'version', 'step'].includes(key))) throw invalid()
  const subject = redactSupportCredentials(text(body.subject, 3, 200))
  const message = redactSupportCredentials(text(body.message, 3, 4000))
  const key = text(body.idempotency_key, 8, 128)
  if (!/^[a-z0-9._:-]+$/iu.test(key)) throw invalid()
  const diagnostic: string[] = []
  for (const field of ['request_id', 'trace_id', 'version', 'step']) {
    if (body[field] === undefined) continue
    const value = text(body[field], 1, 128)
    if (!/^[\p{L}\p{N} ._:/-]+$/u.test(value) || redactSupportCredentials(value) !== value) throw invalid()
    diagnostic.push(`${field}: ${value}`)
  }
  try {
    const result = await repository.create({ workspaceId: context.workspaceId, actorId: context.actorId,
      customerId: context.customerId, customerName: context.customerName, subject,
      description: [message, ...diagnostic].join('\n'), priority: 'normal', tags: ['merchant_support_intake'],
      idempotencyKey: `merchant-support:${context.customerId}:${key}` })
    return receipt(result.ticket, result.replayed)
  } catch (error) {
    if ((error as { code?: string }).code === 'SUPPORT_TICKET_IDEMPOTENCY_CONFLICT') throw new DomainError('SUPPORT_REQUEST_IDEMPOTENCY_CONFLICT', '原请求标识已经用于其他问题，请查询原登记结果', 409)
    throw new DomainError('SUPPORT_REQUEST_OUTCOME_UNKNOWN', '登记结果尚未确认，请使用原请求标识重试，避免重复提交', 503, { retryable: true })
  }
}
export async function getMerchantSupportRequest(repository: SupportRepository | undefined, context: MerchantSupportContext, ticketId: string): Promise<MerchantSupportRequestView> {
  contextVerified(context)
  if (!repository) throw new DomainError('SUPPORT_REPOSITORY_UNAVAILABLE', '支持登记仓储未配置', 503)
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(ticketId)) throw invalid()
  const ticket = await repository.get(context.workspaceId, ticketId)
  if (!ticket || ticket.customerId !== context.customerId) throw new DomainError('SUPPORT_REQUEST_NOT_FOUND', '支持登记不存在或不属于当前账号及企业', 404)
  const replies = (await repository.listEvents(context.workspaceId, ticketId))
    .filter(event => event.eventType === 'commented' && event.payload.visibility === 'customer' && typeof event.payload.body === 'string')
    .map(event => ({ id: event.id, body: redactSupportCredentials(event.payload.body as string), created_at: event.createdAt }))
  return { ...receipt(ticket, false), subject: ticket.subject, replies }
}
