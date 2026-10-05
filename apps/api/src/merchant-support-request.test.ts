import { describe, expect, it } from 'vitest'
import { MemorySupportRepository } from '../../../packages/persistence/src/support-repository.js'
import { getMerchantSupportRequest, submitMerchantSupportRequest } from './merchant-support-request.js'
const context = { workspaceId: 'ws_support_test', actorId: 'customer-actor', customerId: 'stable-identity', customerName: '真实客户' }
const body = { subject: '首次购买受阻', message: '目录暂不可用，请帮忙核查 Bearer abc.secret.jwt password=abc123', idempotency_key: 'first-support-1', request_id: 'request-123', version: '1.0', step: 'catalog' }
describe('first-order merchant support intake', () => {
  it('persists a real no-order ticket, returns original receipt on retry and removes credentials', async () => {
    const repository = new MemorySupportRepository()
    const receipt = await submitMerchantSupportRequest(repository, context, body)
    expect(receipt).toMatchObject({ submitted: true, replayed: false, status: 'open' })
    expect(receipt.ticket_number).toMatch(/^SUP-/u)
    const ticket = await repository.get(context.workspaceId, receipt.ticket_id)
    expect(ticket).toMatchObject({ customerId: context.customerId, priority: 'normal' })
    expect(ticket?.relatedOrderId).toBeUndefined()
    expect(ticket?.relatedTaskId).toBeUndefined()
    expect(ticket?.description).toContain('request_id: request-123')
    expect(ticket?.description).not.toContain('abc.secret.jwt')
    expect(ticket?.description).not.toContain('abc123')
    expect(await submitMerchantSupportRequest(repository, context, body)).toMatchObject({ ticket_id: receipt.ticket_id, replayed: true })
    await expect(submitMerchantSupportRequest(repository, context, { ...body, message: '不同意图' })).rejects.toMatchObject({ code: 'SUPPORT_REQUEST_IDEMPOTENCY_CONFLICT', status: 409 })
  })
  it('returns only customer-visible replies and denies other accounts or workspaces despite copied request identifiers', async () => {
    const repository = new MemorySupportRepository(), receipt = await submitMerchantSupportRequest(repository, context, body)
    const mutation = { workspaceId: context.workspaceId, ticketId: receipt.ticket_id, actorId: 'support-staff', expectedRevision: 1, idempotencyKey: 'internal-reply-1' }
    await repository.comment({ ...mutation, body: '内部调查', visibility: 'internal' })
    await repository.comment({ ...mutation, expectedRevision: 2, idempotencyKey: 'public-reply-1', body: '已核查，请重试', visibility: 'customer' })
    const result = await getMerchantSupportRequest(repository, context, receipt.ticket_id)
    expect(result.replies.map(reply => reply.body)).toEqual(['已核查，请重试'])
    for (const stranger of [{ ...context, workspaceId: 'ws_else' }, { ...context, customerId: 'other-identity' }]) {
      await expect(getMerchantSupportRequest(repository, stranger, receipt.ticket_id)).rejects.toMatchObject({ code: 'SUPPORT_REQUEST_NOT_FOUND', status: 404 })
    }
  })
  it('rejects forged privilege fields, secret-shaped diagnostic IDs and unbound identities before persistence', async () => {
    const repository = new MemorySupportRepository()
    await expect(submitMerchantSupportRequest(repository, context, { ...body, customer_id: 'victim' })).rejects.toMatchObject({ code: 'SUPPORT_REQUEST_INVALID' })
    await expect(submitMerchantSupportRequest(repository, context, { ...body, trace_id: 'token=secret' })).rejects.toMatchObject({ code: 'SUPPORT_REQUEST_INVALID' })
    await expect(submitMerchantSupportRequest(repository, context, { ...body, request_id: 'Bearer secretToken' })).rejects.toMatchObject({ code: 'SUPPORT_REQUEST_INVALID' })
    await expect(submitMerchantSupportRequest(repository, { ...context, customerId: '' }, body)).rejects.toMatchObject({ code: 'SUPPORT_REQUEST_FORBIDDEN' })
    await expect(submitMerchantSupportRequest(undefined, context, body)).rejects.toMatchObject({ code: 'SUPPORT_REPOSITORY_UNAVAILABLE' })
    expect((await repository.list({ workspaceId: context.workspaceId })).items).toEqual([])
  })
})
