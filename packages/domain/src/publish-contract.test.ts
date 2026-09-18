import { describe, expect, it } from 'vitest'
import { confirmPublish, issueConfirmationToken, prepareManualPublish, reconcilePublishJob, startReconciliation, transitionPublishJob, verifyPlatformPublish, type PublishJob } from './publish.js'

const runtime = { now: () => '2026-09-01T00:00:00.000Z', nextId: (prefix: string) => `${prefix}_1` }
const token = (expiresAt = '2026-09-02T00:00:00.000Z') => issueConfirmationToken({
  workspaceId: 'ws_1', platform: 'tmall', taskId: 'task_1', contentVersionId: 'cv_1',
  remoteSnapshotHash: 'remote_hash', confirmationHash: 'confirm_hash', expiresAt,
}, runtime)
const input = { workspaceId: 'ws_1', taskId: 'task_1', contentVersionId: 'cv_1', confirmationHash: 'confirm_hash', remoteSnapshotHash: 'remote_hash', idempotencyKey: 'idem_1' }

describe('publish state contract', () => {
  it('requires a matching, unexpired one-time confirmation and is idempotent', () => {
    const issued = token()
    const first = confirmPublish(issued, input, new Map(), runtime, new Map())
    expect(first).toMatchObject({ ok: true, value: { state: 'confirmed', attempt: 1, confirmationTokenValue: 'confirm_1' } })
    if (!first.ok) return
    expect(confirmPublish(issued, input, new Map([['idem_1', first.value]]), runtime, new Map())).toMatchObject({ ok: true, value: { id: first.value.id } })
    expect(confirmPublish(issued, { ...input, confirmationHash: 'other' }, new Map(), runtime, new Map())).toMatchObject({ ok: false, error: { code: 'PUBLISH_CONFIRMATION_STALE' } })
    expect(confirmPublish(issued, input, new Map(), runtime, new Map([['confirm_1', first.value]]))).toMatchObject({ ok: false, error: { code: 'PUBLISH_CONFIRMATION_REPLAYED' } })
  })

  it('rejects expired tokens and idempotency keys bound to another intent', () => {
    expect(confirmPublish(token('2026-08-31T23:59:59.000Z'), input, new Map(), runtime, new Map())).toMatchObject({ ok: false, error: { code: 'PUBLISH_CONFIRMATION_EXPIRED' } })
    const existing: PublishJob = { id: 'publish_1', workspaceId: 'ws_1', taskId: 'task_other', contentVersionId: 'cv_1', platform: 'tmall', idempotencyKey: 'idem_1', confirmationHash: 'confirm_hash', remoteSnapshotHash: 'remote_hash', confirmationTokenValue: 'confirm_old', state: 'confirmed', attempt: 1, createdAt: runtime.now() }
    expect(confirmPublish(token(), input, new Map([['idem_1', existing]]), runtime, new Map())).toMatchObject({ ok: false, error: { code: 'PUBLISH_IDEMPOTENCY_CONFLICT' } })
  })

  it('forces unknown jobs through reconciliation before any remote outcome is accepted', () => {
    const unknown: PublishJob = { id: 'publish_1', workspaceId: 'ws_1', taskId: 'task_1', contentVersionId: 'cv_1', platform: 'tmall', idempotencyKey: 'idem_1', confirmationHash: 'confirm_hash', remoteSnapshotHash: 'remote_hash', confirmationTokenValue: 'confirm_1', state: 'unknown', attempt: 1, createdAt: runtime.now() }
    expect(startReconciliation(unknown)).toMatchObject({ ok: true, value: { state: 'reconciling' } })
    expect(reconcilePublishJob(unknown, 'published')).toMatchObject({ ok: false, error: { code: 'PUBLISH_RECONCILIATION_REQUIRED' } })
    const reconciling = startReconciliation(unknown)
    if (!reconciling.ok) return
    expect(reconcilePublishJob(reconciling.value, 'absent')).toMatchObject({ ok: true, value: { state: 'manual_attention' } })
    expect(transitionPublishJob(unknown, 'published')).toMatchObject({ ok: false, error: { code: 'PUBLISH_INVALID_TRANSITION' } })
  })

  it('models manual delivery without treating an operator report as platform publication', () => {
    const confirmed = confirmPublish(token(), input, new Map(), runtime, new Map())
    if (!confirmed.ok) throw new Error('fixture publish failed')
    const exported = prepareManualPublish(confirmed.value)
    expect(exported).toMatchObject({ ok: true, value: { state: 'export_ready' } })
    if (!exported.ok) return
    const inProgress = transitionPublishJob(exported.value, 'manual_publish_in_progress')
    if (!inProgress.ok) throw new Error('fixture manual publish failed')
    const reported = transitionPublishJob(inProgress.value, 'manual_publish_reported')
    expect(reported).toMatchObject({ ok: true, value: { state: 'manual_publish_reported' } })
    if (!reported.ok) return
    expect(transitionPublishJob(reported.value, 'published')).toMatchObject({ ok: false, error: { code: 'PUBLISH_INVALID_TRANSITION' } })
    expect(transitionPublishJob(reported.value, 'platform_verified')).toMatchObject({ ok: false, error: { code: 'PUBLISH_INVALID_TRANSITION' } })
    expect(transitionPublishJob(reported.value, 'manual_review_required')).toMatchObject({ ok: true, value: { state: 'manual_review_required' } })
  })

  it('requires a complete official API receipt for platform_verified', () => {
    const reported: PublishJob = { id: 'publish_1', workspaceId: 'ws_1', taskId: 'task_1', contentVersionId: 'cv_1', platform: 'tmall', idempotencyKey: 'idem_1', confirmationHash: 'confirm_hash', remoteSnapshotHash: 'remote_hash', confirmationTokenValue: 'confirm_1', state: 'manual_publish_reported', attempt: 1, createdAt: runtime.now() }
    expect(verifyPlatformPublish(reported, { source: 'official_api', receiptId: '', remoteResourceId: 'item_1', verifiedAt: runtime.now() })).toMatchObject({ ok: false, error: { code: 'PUBLISH_CONFIRMATION_REQUIRED' } })
    expect(verifyPlatformPublish(reported, { source: 'manual_screenshot', receiptId: 'screenshot_1', remoteResourceId: 'item_1', verifiedAt: runtime.now() } as never)).toMatchObject({ ok: false, error: { code: 'PUBLISH_CONFIRMATION_REQUIRED' } })
    expect(verifyPlatformPublish(reported, { source: 'official_api', receiptId: 'receipt_1', remoteResourceId: 'item_1', verifiedAt: runtime.now() })).toMatchObject({
      ok: true,
      value: { state: 'platform_verified', platformVerification: { source: 'official_api', receiptId: 'receipt_1', remoteResourceId: 'item_1' } },
    })
  })
})
