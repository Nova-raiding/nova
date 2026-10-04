import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CampaignDeliveryManifestMachine,
  CampaignManifestError,
  type CampaignDeliveryItemInput,
  type CampaignDeliveryManifestInput,
  type CampaignPublishConfirmation,
  type CampaignPublishReceipt,
  type CampaignReviewApproval,
} from './campaign-delivery-manifest.js'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const at = '2026-08-29T08:00:00.000Z'

function item(
  id: string,
  platform: CampaignDeliveryItemInput['platform'],
  accountId: string,
  productId: string,
): CampaignDeliveryItemInput {
  const listingId = `listing-${id}`
  const skuIds = [`sku-${id}-1`, `sku-${id}-2`]
  const contentVersion = { id: `content-${id}`, hash: digest(`content-${id}`) }
  const visualVersions = [{ id: `visual-${id}-desktop`, hash: digest(`visual-${id}-desktop`) }, { id: `visual-${id}-mobile`, hash: digest(`visual-${id}-mobile`) }]
  const specification = { id: `spec-${id}`, hash: digest(`spec-${id}`), evidenceState: 'production_canary' as const, evidenceRef: `canary://${platform}/${id}` }
  const activityPolicy = { id: `activity-${id}`, hash: digest(`activity-${id}`), validUntil: '2026-09-30T15:59:59.000Z' }
  const ruleSnapshot = { id: `rules-${id}`, hash: digest(`rules-${id}`), checkedAt: at, evidenceRef: `rules://${id}` }

  return {
    id,
    productId,
    listingId,
    skuIds,
    platform,
    accountId,
    contentVersion,
    visualVersions,
    specification,
    activityPolicy,
    ruleSnapshot,
    versionVector: {
      campaignId: 'campaign-1',
      brandId: 'brand-1',
      productId,
      listingId,
      skuIds,
      platform,
      accountId,
      contentVersionId: contentVersion.id,
      visualVersionIds: visualVersions.map(version => version.id),
      specificationId: specification.id,
      activityPolicyId: activityPolicy.id,
      ruleSnapshotId: ruleSnapshot.id,
    },
    review: { status: 'pending' },
    publish: { status: 'not_ready' },
  }
}

function manifest(items: CampaignDeliveryItemInput[] = [
  item('taobao-a', 'taobao', 'account-cn-a', 'product-a'),
  item('jd-b', 'jd', 'account-cn-b', 'product-b'),
]): CampaignDeliveryManifestInput {
  return {
    id: 'manifest-1',
    workspaceId: 'workspace-1',
    campaignId: 'campaign-1',
    brandId: 'brand-1',
    items,
  }
}

function approvalFor(item: CampaignDeliveryItemInput, id = `approval-${item.id}`): CampaignReviewApproval {
  return {
    id,
    platform: item.platform,
    accountId: item.accountId,
    productId: item.productId,
    listingId: item.listingId,
    contentVersionId: item.contentVersion.id,
    visualVersionIds: item.visualVersions.map(version => version.id),
    ruleSnapshotId: item.ruleSnapshot.id,
    approvedBy: `reviewer-${item.id}`,
    approvedAt: at,
  }
}

function confirmationFor(
  item: ReturnType<CampaignDeliveryManifestMachine['snapshot']>['items'][number],
  id = `confirmation-${item.id}`,
): CampaignPublishConfirmation {
  if (!item.publish.remoteSnapshotHash) throw new Error('test requires a remote snapshot')
  return {
    id,
    platform: item.platform,
    accountId: item.accountId,
    productId: item.productId,
    listingId: item.listingId,
    versionVectorHash: item.versionVectorHash,
    remoteSnapshotHash: item.publish.remoteSnapshotHash,
    confirmedBy: `publisher-${item.id}`,
    confirmedAt: at,
  }
}

function receiptFor(item: CampaignDeliveryItemInput): CampaignPublishReceipt {
  return {
    id: `receipt-${item.id}`,
    platform: item.platform,
    accountId: item.accountId,
    productId: item.productId,
    listingId: item.listingId,
    remoteId: `remote-${item.id}`,
    receiptRef: `receipt://${item.platform}/${item.id}`,
    publishedAt: at,
  }
}

function currentItem(machine: CampaignDeliveryManifestMachine, itemId: string) {
  const found = machine.snapshot().items.find(candidate => candidate.id === itemId)
  if (!found) throw new Error(`missing test item ${itemId}`)
  return found
}

function approveAndConfirm(machine: CampaignDeliveryManifestMachine, itemId: string) {
  let current = currentItem(machine, itemId)
  machine.approveReview(itemId, approvalFor(current), `approve:${itemId}`)
  machine.observeRemoteSnapshot(itemId, digest(`remote-before:${itemId}`), `observe:${itemId}`)
  current = currentItem(machine, itemId)
  machine.confirmPublish(itemId, confirmationFor(current), `confirm:${itemId}`)
}

function publish(machine: CampaignDeliveryManifestMachine, itemId: string) {
  machine.startPublishing(itemId, `start:${itemId}`)
  machine.recordPublishResult(itemId, { state: 'published', receipt: receiptFor(currentItem(machine, itemId)) }, `result:${itemId}`)
}

function expectCode(action: () => unknown, code: CampaignManifestError['code']) {
  try {
    action()
    throw new Error(`expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(CampaignManifestError)
    expect((error as CampaignManifestError).code).toBe(code)
  }
}

describe('campaign delivery manifest state machine', () => {
  it('keeps review, confirmation and version vectors independent for every platform/product', () => {
    const machine = new CampaignDeliveryManifestMachine(manifest())
    const first = currentItem(machine, 'taobao-a')
    const second = currentItem(machine, 'jd-b')

    machine.approveReview(first.id, approvalFor(first), 'approve:first')
    expect(currentItem(machine, second.id).review.status).toBe('pending')
    expect(currentItem(machine, second.id).publish.confirmation).toBeUndefined()

    expectCode(
      () => machine.approveReview(second.id, approvalFor(second, `approval-${first.id}`), 'approve:reused'),
      'CAMPAIGN_APPROVAL_REUSED',
    )

    machine.approveReview(second.id, approvalFor(second), 'approve:second')
    machine.observeRemoteSnapshot(first.id, digest('remote:first'), 'observe:first')
    machine.observeRemoteSnapshot(second.id, digest('remote:second'), 'observe:second')
    const firstConfirmation = confirmationFor(currentItem(machine, first.id))
    machine.confirmPublish(first.id, firstConfirmation, 'confirm:first')
    expectCode(
      () => machine.confirmPublish(second.id, confirmationFor(currentItem(machine, second.id), firstConfirmation.id), 'confirm:reused'),
      'CAMPAIGN_CONFIRMATION_REUSED',
    )
    machine.confirmPublish(second.id, confirmationFor(currentItem(machine, second.id)), 'confirm:second')

    publish(machine, first.id)
    expect(machine.snapshot()).toMatchObject({ state: 'partial', progress: { total: 2, published: 1, percent: 50 } })
    publish(machine, second.id)
    expect(machine.snapshot()).toMatchObject({ state: 'completed', progress: { reviewed: 2, confirmed: 2, published: 2, percent: 100 } })
  })

  it('reports partial progress and a per-item retry action after one platform fails', () => {
    const machine = new CampaignDeliveryManifestMachine(manifest())
    approveAndConfirm(machine, 'taobao-a')
    approveAndConfirm(machine, 'jd-b')
    publish(machine, 'taobao-a')
    machine.startPublishing('jd-b', 'start:jd-b')
    machine.recordPublishResult('jd-b', { state: 'failed', error: { code: 'REMOTE_TIMEOUT', message: 'JD timed out' } }, 'result:jd-b')

    const snapshot = machine.snapshot()
    expect(snapshot).toMatchObject({ state: 'partial', progress: { published: 1, failed: 1, percent: 50 } })
    expect(currentItem(machine, 'taobao-a').nextAction).toBe('none')
    expect(currentItem(machine, 'jd-b')).toMatchObject({ nextAction: 'retry_failed', publish: { attempts: 1, error: { code: 'REMOTE_TIMEOUT' } } })
  })

  it('pauses and resumes without losing confirmations or permitting sends while paused', () => {
    const machine = new CampaignDeliveryManifestMachine(manifest([item('taobao-a', 'taobao', 'account-cn-a', 'product-a')]))
    approveAndConfirm(machine, 'taobao-a')

    machine.pause('merchant requested a hold', 'pause:1')
    expect(machine.snapshot()).toMatchObject({ state: 'paused', paused: true, pauseReason: 'merchant requested a hold' })
    expect(currentItem(machine, 'taobao-a').nextAction).toBe('resume_campaign')
    expectCode(() => machine.startPublishing('taobao-a', 'start:paused'), 'CAMPAIGN_INVALID_TRANSITION')

    machine.resume('resume:1')
    expect(machine.snapshot().paused).toBe(false)
    expect(currentItem(machine, 'taobao-a')).toMatchObject({ nextAction: 'publish_item', publish: { status: 'confirmed' } })
    publish(machine, 'taobao-a')
    expect(machine.snapshot().state).toBe('completed')
  })

  it('retries failed items idempotently and never increments an attempt twice for one key', () => {
    const machine = new CampaignDeliveryManifestMachine(manifest([item('taobao-a', 'taobao', 'account-cn-a', 'product-a')]))
    approveAndConfirm(machine, 'taobao-a')
    machine.startPublishing('taobao-a', 'start:first')
    machine.recordPublishResult('taobao-a', { state: 'failed', error: { code: 'NETWORK', message: 'temporary failure' } }, 'result:first')

    const retried = machine.retryFailed(undefined, 'retry:all')
    const repeatedRetry = machine.retryFailed(undefined, 'retry:all')
    expect(repeatedRetry).toEqual(retried)
    expect(currentItem(machine, 'taobao-a').publish).toMatchObject({ status: 'confirmed', attempts: 1 })

    const started = machine.startPublishing('taobao-a', 'start:retry')
    const repeatedStart = machine.startPublishing('taobao-a', 'start:retry')
    expect(repeatedStart).toEqual(started)
    expect(currentItem(machine, 'taobao-a').publish.attempts).toBe(2)
    expectCode(() => machine.resume('start:retry'), 'CAMPAIGN_IDEMPOTENCY_CONFLICT')
  })

  it('invalidates publish confirmation when the remote snapshot hash changes', () => {
    const machine = new CampaignDeliveryManifestMachine(manifest([item('taobao-a', 'taobao', 'account-cn-a', 'product-a')]))
    approveAndConfirm(machine, 'taobao-a')
    expect(currentItem(machine, 'taobao-a').publish.status).toBe('confirmed')

    machine.observeRemoteSnapshot('taobao-a', digest('remote-after:taobao-a'), 'observe:changed')
    expect(currentItem(machine, 'taobao-a')).toMatchObject({ nextAction: 'confirm_publish', publish: { status: 'awaiting_confirmation' } })
    expect(currentItem(machine, 'taobao-a').publish.confirmation).toBeUndefined()
    expectCode(() => machine.startPublishing('taobao-a', 'start:stale-confirmation'), 'CAMPAIGN_INVALID_TRANSITION')
  })

  it('hard-blocks cross-account confirmations and mixed-account version vectors', () => {
    const machine = new CampaignDeliveryManifestMachine(manifest([item('taobao-a', 'taobao', 'account-cn-a', 'product-a')]))
    const scoped = currentItem(machine, 'taobao-a')
    machine.approveReview(scoped.id, approvalFor(scoped), 'approve:scoped')
    machine.observeRemoteSnapshot(scoped.id, digest('remote:scoped'), 'observe:scoped')
    const wrongAccount = { ...confirmationFor(currentItem(machine, scoped.id)), accountId: 'account-attacker' }
    expectCode(() => machine.confirmPublish(scoped.id, wrongAccount, 'confirm:wrong-account'), 'CAMPAIGN_CONFIRMATION_SCOPE_MISMATCH')

    const leaked = item('leaked', 'jd', 'account-safe', 'product-safe')
    leaked.versionVector.accountId = 'account-attacker'
    expectCode(() => new CampaignDeliveryManifestMachine(manifest([leaked])), 'CAMPAIGN_VERSION_SCOPE_LEAK')
  })

  it('fails closed for limits, duplicate scopes, missing canary evidence and shared versions', () => {
    const tooMany = Array.from({ length: 51 }, (_, index) => item(`bulk-${index}`, 'taobao', `account-${index}`, `product-${index}`))
    expectCode(() => new CampaignDeliveryManifestMachine(manifest(tooMany)), 'CAMPAIGN_ITEM_LIMIT_EXCEEDED')

    const duplicate = item('duplicate', 'taobao', 'account-one', 'product-one')
    expectCode(() => new CampaignDeliveryManifestMachine(manifest([duplicate, { ...structuredClone(duplicate), id: 'duplicate-2' }])), 'CAMPAIGN_ITEM_DUPLICATE')

    const unverified = item('unverified', 'jd', 'account-jd', 'product-jd')
    unverified.specification.evidenceState = 'official_document'
    expectCode(() => new CampaignDeliveryManifestMachine(manifest([unverified])), 'CAMPAIGN_ITEM_EVIDENCE_REQUIRED')

    const first = item('first', 'taobao', 'account-first', 'product-first')
    const second = item('second', 'jd', 'account-second', 'product-second')
    second.contentVersion.id = first.contentVersion.id
    second.versionVector.contentVersionId = first.contentVersion.id
    expectCode(() => new CampaignDeliveryManifestMachine(manifest([first, second])), 'CAMPAIGN_VERSION_SCOPE_LEAK')
  })
})
