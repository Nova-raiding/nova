import { describe, expect, it } from 'vitest'
import { confirmPublish, issueConfirmationToken, reconcilePublishJob, startReconciliation, transitionPublishJob, type PublishJob } from './publish.js'

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
})
