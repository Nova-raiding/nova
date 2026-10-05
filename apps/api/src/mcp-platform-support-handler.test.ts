import type { IncomingMessage } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { MemorySupportRepository } from '../../../packages/persistence/src/support-repository.js'
import { getMerchantSupportRequest, submitMerchantSupportRequest } from './merchant-support-request.js'
import { handleMcpPlatformSupport, type McpPlatformSupportDependencies } from './mcp-platform-support-handler.js'
const req = { headers: { 'x-workspace-id': 'platform' } } as unknown as IncomingMessage
const customer = { workspaceId: 'ws_first_support', actorId: 'customer-actor', customerId: 'member:stable-member', customerName: '客户本人' }
function dependencies(repository: MemorySupportRepository): McpPlatformSupportDependencies {
  return { repository, requirePlatformOperations: vi.fn(), requireSupportCapability: vi.fn(), requireTargetWorkspace: vi.fn(), requestActor: () => 'trusted-platform-support', invokeOpsDomain: fn => fn() }
}
describe('explicit platform support handoff', () => {
  it('actual no-order request can be read/replied by platform and queried by its customer without changing workbench headers', async () => {
    const repository = new MemorySupportRepository(), deps = dependencies(repository)
    const receipt = await submitMerchantSupportRequest(repository, customer, { subject: '首单目录错误', message: '还没有订单，请协助核查', idempotency_key: 'first-support-case' })
    const target = { target_workspace_id: customer.workspaceId }
    const page = await handleMcpPlatformSupport('ops.support.platform.tickets.list', target, req, deps) as { items: { id: string }[] }
    expect(page.items.map(ticket => ticket.id)).toEqual([receipt.ticket_id])
    const view = await handleMcpPlatformSupport('ops.support.platform.ticket.get', { ...target, ticket_id: receipt.ticket_id }, req, deps) as { ticket: { revision: number } }
    const write = { ...target, ticket_id: receipt.ticket_id, body: '已核实企业并修复，请重试', visibility: 'customer', expected_revision: String(view.ticket.revision), idempotency_key: 'platform-reply-case' }
    const response = await handleMcpPlatformSupport('ops.support.platform.ticket.comment', write, req, deps) as { event: { actorId: string; idempotencyKey: string }; replayed: boolean }
    expect(response.event).toMatchObject({ actorId: 'trusted-platform-support', idempotencyKey: write.idempotency_key })
    expect(await handleMcpPlatformSupport('ops.support.platform.ticket.comment', write, req, deps)).toMatchObject({ replayed: true })
    expect((await getMerchantSupportRequest(repository, customer, receipt.ticket_id)).replies.map(reply => reply.body)).toEqual([write.body])
    expect(req.headers['x-workspace-id']).toBe('platform')
    expect(deps.requireSupportCapability).toHaveBeenCalledWith(req, customer.workspaceId, 'support.ticket.update')
  })
  it('requires platform workbench and independent read/write support grants before repository reads or writes', async () => {
    const repo = new MemorySupportRepository(), deps = dependencies(repo)
    const list = vi.spyOn(repo, 'list')
    deps.requirePlatformOperations = () => { throw Object.assign(new Error('wrong workbench'), { code: 'AUTHZ_WORKBENCH_MISMATCH' }) }
    await expect(handleMcpPlatformSupport('ops.support.platform.tickets.list', { target_workspace_id: customer.workspaceId }, req, deps)).rejects.toMatchObject({ code: 'AUTHZ_WORKBENCH_MISMATCH' })
    deps.requirePlatformOperations = vi.fn()
    deps.requireSupportCapability = () => { throw Object.assign(new Error('missing support grant'), { code: 'AUTHZ_CAPABILITY_REQUIRED' }) }
    for (const method of ['ops.support.platform.tickets.list', 'ops.support.platform.ticket.comment']) await expect(handleMcpPlatformSupport(method, { target_workspace_id: customer.workspaceId }, req, deps)).rejects.toMatchObject({ code: 'AUTHZ_CAPABILITY_REQUIRED' })
    expect(list).not.toHaveBeenCalled()
  })
  it('requires an explicit known target and rejects caller identity/scope overrides', async () => {
    const repo = new MemorySupportRepository(), deps = dependencies(repo), list = vi.spyOn(repo, 'list')
    for (const params of [{}, { target_workspace_id: customer.workspaceId, actor_id: 'admin' }, { target_workspace_id: customer.workspaceId, workspace_id: 'victim' }]) await expect(handleMcpPlatformSupport('ops.support.platform.tickets.list', params, req, deps)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    deps.requireTargetWorkspace = () => { throw Object.assign(new Error('missing workspace'), { code: 'WORKSPACE_NOT_FOUND' }) }
    await expect(handleMcpPlatformSupport('ops.support.platform.tickets.list', { target_workspace_id: 'ws_unknown' }, req, deps)).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' })
    expect(list).not.toHaveBeenCalled()
  })
  it('cannot get/comment a ticket from a different explicit enterprise', async () => {
    const repo = new MemorySupportRepository(), deps = dependencies(repo)
    const ticket = await submitMerchantSupportRequest(repo, customer, { subject: '首单失败', message: '尚无业务标识', idempotency_key: 'other-tenant-case' })
    await expect(handleMcpPlatformSupport('ops.support.platform.ticket.get', { target_workspace_id: 'ws_other', ticket_id: ticket.ticket_id }, req, deps)).rejects.toMatchObject({ code: 'SUPPORT_TICKET_NOT_FOUND' })
    await expect(handleMcpPlatformSupport('ops.support.platform.ticket.comment', { target_workspace_id: 'ws_other', ticket_id: ticket.ticket_id, body: '错误目标', visibility: 'customer', expected_revision: '1', idempotency_key: 'wrong-target-reply' }, req, deps)).rejects.toMatchObject({ code: 'SUPPORT_TICKET_NOT_FOUND' })
  })
})
