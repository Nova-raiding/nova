import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MemoryInteractiveConfirmationTicketRepository } from '../../../packages/persistence/src/interactive-confirmation-ticket-repository.js'
import { DomainError } from '../../../packages/application/src/service.js'
import { consumeVideoRenderingApprovalTicket, videoRenderingApprovalIntentHash } from './video-rendering-approval.js'

const context = {
  product: { id: 'product-a', version: '4', hash: 'facts-a' },
  brand: { id: 'brand-a', version: '2' },
  rules: [{ id: 'rules-a', version: '3' }],
  brief: { id: 'brief-a', version: '7' },
  assets: [{ id: 'asset-a', version: '2', sha256: 'asset-hash' }],
  storyboard: { scenes: [{ id: 'scene-1', visual: '展示蓝色商品' }] },
}

async function issue(contextValue: unknown = context, scope = { workspaceId: 'ws-a', actorId: 'actor-a', sessionId: 'session-a' }, now = new Date('2026-10-11T00:00:00.000Z')) {
  let currentTime = now
  const repository = new MemoryInteractiveConfirmationTicketRepository(() => currentTime)
  const nonce = 'a'.repeat(64)
  const intentHash = videoRenderingApprovalIntentHash({ workspaceId: scope.workspaceId, prompt: '按确认分镜渲染', context: contextValue })
  await repository.issue({ ...scope, intentHash, nonceHash: createHash('sha256').update(nonce).digest('hex'), expiresAt: new Date(now.getTime() + 60_000).toISOString() })
  return { repository, nonce, intentHash, scope, now, advance: (milliseconds: number) => { currentTime = new Date(now.getTime() + milliseconds) } }
}

describe('video rendering approval ticket', () => {
  it('consumes one ticket bound to the exact normalized product, brief, assets and storyboard', async () => {
    const ticket = await issue()
    const input = { ...ticket.scope, prompt: '按确认分镜渲染', context, nonce: ticket.nonce, intentHash: ticket.intentHash, repository: ticket.repository, now: ticket.now }
    await expect(consumeVideoRenderingApprovalTicket(input)).resolves.toBeUndefined()
    await expect(consumeVideoRenderingApprovalTicket(input)).rejects.toMatchObject({ code: 'INTERACTIVE_CONFIRMATION_TICKET_INVALID' })
  })

  it('rejects a changed storyboard, brief, product, asset, workspace, actor or session before consumption', async () => {
    const ticket = await issue()
    const base = { ...ticket.scope, prompt: '按确认分镜渲染', context, nonce: ticket.nonce, intentHash: ticket.intentHash, repository: ticket.repository, now: ticket.now }
    const changed = [
      { ...base, context: { ...context, storyboard: { scenes: [{ id: 'scene-1', visual: '展示红色商品' }] } } },
      { ...base, context: { ...context, brief: { ...context.brief, version: '8' } } },
      { ...base, context: { ...context, product: { ...context.product, version: '5' } } },
      { ...base, context: { ...context, assets: [{ ...context.assets[0]!, sha256: 'changed' }] } },
      { ...base, workspaceId: 'ws-b' },
      { ...base, actorId: 'actor-b' },
      { ...base, sessionId: 'session-b' },
    ]
    for (const value of changed) await expect(consumeVideoRenderingApprovalTicket(value)).rejects.toBeInstanceOf(DomainError)
    await expect(consumeVideoRenderingApprovalTicket(base)).resolves.toBeUndefined()
  })

  it('rejects an expired ticket', async () => {
    const ticket = await issue()
    ticket.advance(60_000)
    await expect(consumeVideoRenderingApprovalTicket({ ...ticket.scope, prompt: '按确认分镜渲染', context, nonce: ticket.nonce, intentHash: ticket.intentHash, repository: ticket.repository }))
      .rejects.toMatchObject({ code: 'INTERACTIVE_CONFIRMATION_TICKET_INVALID' })
  })

  it('uses a stable intent hash independent of object key order', () => {
    expect(videoRenderingApprovalIntentHash({ workspaceId: 'ws-a', prompt: 'p', context: { b: 2, a: 1 } }))
      .toBe(videoRenderingApprovalIntentHash({ workspaceId: 'ws-a', prompt: 'p', context: { a: 1, b: 2 } }))
  })
})
