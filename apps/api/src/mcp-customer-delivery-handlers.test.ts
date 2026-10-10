import type { IncomingMessage } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import {
  handleCustomerDeliveryMcpMethod,
  type CustomerDeliveryMcpDependencies,
} from './mcp-customer-delivery-handlers.js'

function harness() {
  const repository = {
    listBindableAccounts: vi.fn(async () => ({ items: [] })),
    list: vi.fn(async () => ({ items: [], total: 0, offset: 0, limit: 20, hasMore: false })),
    listOwnerOptions: vi.fn(async () => ({ projectOwnerOptions: [], supportOwnerOptions: [] })),
    bindAccount: vi.fn(async () => undefined),
    updateChecklistItems: vi.fn(async () => undefined),
    updateChecklistItem: vi.fn(async () => undefined),
    addVideo: vi.fn(async () => undefined),
  }
  const invokeCustomerDeliveryDomain = vi.fn(async <T>(operation: () => Promise<T>) => operation())
  const updateCustomerDeliveryWithRequiredEvidence = vi.fn(async () => undefined)
  const dependencies = {
    repository,
    persistenceReady: Promise.resolve(),
    result: (value: unknown) => value,
    requestActor: () => 'test-operator',
    invokeCustomerDeliveryDomain,
    updateCustomerDeliveryWithRequiredEvidence,
    requireBoundCustomerDeliveryAsset: vi.fn(async () => undefined),
    evidenceRefs: (value: unknown) => Array.isArray(value) ? value : [],
  } as unknown as CustomerDeliveryMcpDependencies

  return { dependencies, repository, invokeCustomerDeliveryDomain, updateCustomerDeliveryWithRequiredEvidence }
}

async function call(method: string, params: Record<string, unknown>, dependencies: CustomerDeliveryMcpDependencies) {
  return handleCustomerDeliveryMcpMethod(method, { method: 'POST' } as IncomingMessage, 'workspace-a', params, dependencies)
}

describe('customer delivery MCP integer input contract', () => {
  it.each([
    ['ops.customer-delivery.accounts.list', { limit: '1e2' }],
    ['ops.customer-delivery.accounts.list', { limit: 51 }],
    ['ops.customer-delivery.list', { offset: '-1' }],
    ['ops.customer-delivery.list', { limit: '1.5' }],
    ['ops.customer-delivery.list', { archived_only: 'yes' }],
    ['ops.customer-delivery.videos.add', { sort_order: -1 }],
  ])('rejects invalid pagination or ordering before dispatching %s', async (method, params) => {
    const test = harness()

    await expect(call(method, params, test.dependencies)).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })

    expect(test.invokeCustomerDeliveryDomain).not.toHaveBeenCalled()
    expect(test.repository.listBindableAccounts).not.toHaveBeenCalled()
    expect(test.repository.list).not.toHaveBeenCalled()
    expect(test.repository.addVideo).not.toHaveBeenCalled()
  })

  it('accepts the digit-string limit used by MCP clients', async () => {
    const test = harness()

    await call('ops.customer-delivery.accounts.list', { limit: '50' }, test.dependencies)

    expect(test.repository.listBindableAccounts).toHaveBeenCalledWith({ workspaceId: 'workspace-a', limit: 50 })
  })

  it('routes archived-only reads through the selected tenant scope', async () => {
    const test = harness()
    await call('ops.customer-delivery.list', { archived_only: 'true' }, test.dependencies)
    expect(test.repository.list).toHaveBeenCalledWith({ workspaceId: 'workspace-a', archivedOnly: true })
  })

  it.each([
    ['ops.customer-delivery.account.bind', { delivery_id: 'delivery-a', target_account_id: 'account-a', reason: 'operator confirmation' }],
    ['ops.customer-delivery.update', { delivery_id: 'delivery-a', patch_json: '{"companyName":"客户甲"}' }],
    ['ops.customer-delivery.checklist.update', { delivery_id: 'delivery-a', checklist_key: 'customer_profile', completed: false }],
    ['ops.customer-delivery.checklist.update', { delivery_id: 'delivery-a', checklist_key: 'system_integration', items_json: '[]' }],
    ['ops.customer-delivery.checklist-item.update', { delivery_id: 'delivery-a', checklist_key: 'system_integration', item_key: '插件账号', completed: false }],
    ['ops.customer-delivery.training.complete', { delivery_id: 'delivery-a', completed: false, evidence_refs_json: '[]' }],
  ])('rejects malformed revision before %s mutates', async (method, params) => {
    const test = harness()

    await expect(call(method, { ...params, expected_revision: '1e2' }, test.dependencies))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })

    expect(test.updateCustomerDeliveryWithRequiredEvidence).not.toHaveBeenCalled()
    expect(test.repository.bindAccount).not.toHaveBeenCalled()
    expect(test.repository.updateChecklistItems).not.toHaveBeenCalled()
    expect(test.repository.updateChecklistItem).not.toHaveBeenCalled()
  })

  it('parses a digit-string expected revision as the numeric revision used by the repository', async () => {
    const test = harness()

    await call('ops.customer-delivery.account.bind', {
      delivery_id: 'delivery-a', target_account_id: 'account-a', expected_revision: '4', reason: 'operator confirmation',
    }, test.dependencies)

    expect(test.repository.bindAccount).toHaveBeenCalledWith({
      workspaceId: 'workspace-a', deliveryId: 'delivery-a', targetAccountId: 'account-a',
      expectedRevision: 4, reason: 'operator confirmation', actorId: 'test-operator',
    })
  })
})
