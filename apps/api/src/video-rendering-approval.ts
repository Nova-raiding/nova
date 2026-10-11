import { createHash } from 'node:crypto'
import { DomainError } from '../../../packages/application/src/service.js'
import type { InteractiveConfirmationTicketRepository } from '../../../packages/persistence/src/interactive-confirmation-ticket-repository.js'

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

export function videoRenderingApprovalIntentHash(input: { workspaceId: string; prompt: string; context: unknown }) {
  return createHash('sha256').update(canonicalJson({ version: 'video-render-approval.v1', workspaceId: input.workspaceId, prompt: input.prompt.trim(), context: input.context })).digest('hex')
}

export async function consumeVideoRenderingApprovalTicket(input: {
  workspaceId: string
  actorId: string
  sessionId: string
  prompt: string
  context: unknown
  nonce: unknown
  intentHash: unknown
  repository: InteractiveConfirmationTicketRepository
}) {
  const nonce = typeof input.nonce === 'string' ? input.nonce.trim() : ''
  const intentHash = typeof input.intentHash === 'string' ? input.intentHash.trim() : ''
  if (!/^[a-f0-9]{64}$/u.test(nonce) || !/^[a-f0-9]{64}$/u.test(intentHash)) {
    throw new DomainError('INTERACTIVE_CONFIRMATION_TICKET_REQUIRED', '视频渲染必须携带当前分镜的一次性交互确认票据', 400)
  }
  const expectedIntent = videoRenderingApprovalIntentHash({ workspaceId: input.workspaceId, prompt: input.prompt, context: input.context })
  if (intentHash !== expectedIntent) throw new DomainError('INTERACTIVE_CONFIRMATION_INTENT_MISMATCH', '视频确认票据与当前商品、素材或分镜版本不一致', 409)
  const storedNonceHash = createHash('sha256').update(nonce).digest('hex')
  const consumed = await input.repository.consume({ workspaceId: input.workspaceId, actorId: input.actorId, sessionId: input.sessionId, intentHash, nonceHash: storedNonceHash, legacyNonceHash: nonce })
  if (!consumed) throw new DomainError('INTERACTIVE_CONFIRMATION_TICKET_INVALID', '视频确认票据不存在、已过期、已消费或不属于当前会话', 409)
}
