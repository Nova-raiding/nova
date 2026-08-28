import { describe, expect, it } from 'vitest'
import {
  approveContentVersion,
  confirmFact,
  confirmPublish,
  createChildContentVersion,
  createContentVersion,
  createInMemoryDomainRepository,
  isFactUsable,
  issueConfirmationToken,
  proposeFact,
  reconcilePublishJob,
  restoreContentVersion,
  submitContentVersionForReview,
  retryPublishJob,
  startReconciliation,
  transitionFact,
  transitionPublishJob,
  transitionTask,
  type FactField,
  type Task,
} from '../domain/src/index.js'

const runtime = (at = '2026-08-22T10:00:00.000Z') => {
  let sequence = 0
  return { now: () => at, nextId: (prefix: string) => `${prefix}_${++sequence}` }
}

const fact = (state: FactField['state'] = 'missing'): FactField<string> => ({ id: 'fact_1', fieldPath: 'product.claims.upf', state, version: 1 })

describe('事实字段状态机', () => {
  it('requires source and explicit actor confirmation before a fact is usable', () => {
    const proposed = proposeFact(fact(), 'UPF50+', { type: 'document', reference: 'asset_1#page-2' })
    expect(proposed.ok).toBe(true)
    if (!proposed.ok) return
    const confirmed = confirmFact(proposed.value, 'actor_1', '2026-08-22T10:00:00.000Z')
    expect(confirmed.ok).toBe(true)
    if (!confirmed.ok) return
    expect(isFactUsable(confirmed.value, '2026-08-22T11:00:00.000Z')).toEqual({ ok: true, value: 'UPF50+' })
  })

  it('rejects direct missing-to-confirmed and expired facts', () => {
    expect(transitionFact(fact('pending_confirmation'), 'confirmed')).toMatchObject({ ok: false, error: { code: 'FACT_CONFIRMATION_REQUIRED' } })
    const proposed = proposeFact({ ...fact(), validTo: '2026-08-22T09:00:00.000Z' }, 'x', { type: 'merchant_input', reference: 'input' })
    if (!proposed.ok) throw new Error('fixture proposal failed')
    const confirmed = confirmFact(proposed.value, 'actor', '2026-08-22T08:00:00.000Z')
    if (!confirmed.ok) throw new Error('fixture confirmation failed')
    expect(isFactUsable(confirmed.value, '2026-08-22T10:00:00.000Z')).toMatchObject({ ok: false, error: { code: 'FACT_NOT_USABLE' } })
  })

  it('does not let a conflict become usable through a state-only edit', () => {
    const conflicted = transitionFact({ ...fact(), state: 'pending_confirmation' }, 'conflict')
    expect(conflicted.ok).toBe(true)
    if (!conflicted.ok) return
    expect(isFactUsable(conflicted.value, '2026-08-22T10:00:00.000Z')).toMatchObject({ ok: false, error: { code: 'FACT_NOT_USABLE' } })
  })
})

describe('Task 状态迁移', () => {
  const task: Task = { id: 'task_1', workspaceId: 'ws_1', state: 'draft', version: 1 }

  it('follows an allowed transition and increments the optimistic version', () => {
    const next = transitionTask(task, 'resolving_context')
    expect(next).toEqual({ ok: true, value: { ...task, state: 'resolving_context', version: 2 } })
  })

  it('returns stable errors for illegal and stale transitions', () => {
    expect(transitionTask(task, 'published' as never)).toMatchObject({ ok: false, error: { code: 'INVALID_TASK_TRANSITION' } })
    expect(transitionTask(task, 'resolving_context', 0)).toMatchObject({ ok: false, error: { code: 'TASK_VERSION_CONFLICT' } })
    const terminal = { ...task, state: 'delivered' as const }
    expect(transitionTask(terminal, 'draft')).toMatchObject({ ok: false, error: { code: 'TASK_TERMINAL' } })
  })
})

describe('ContentVersion 不可变与恢复', () => {
  const body = { title: '轻云防晒外套', detail: 'UPF50+', sellingPoints: ['轻量'] }

  it('freezes the version and creates a child for every edit', () => {
    const first = createContentVersion({ taskId: 'task_1', body, createdBy: 'actor_1', reason: 'initial' }, runtime())
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.body)).toBe(true)
    const child = createChildContentVersion(first, { body: { ...body, title: '新标题' }, createdBy: 'actor_1', reason: 'copy edit', version: 2 }, runtime())
    expect(child.ok).toBe(true)
    if (!child.ok) return
    expect(child.value.parentId).toBe(first.id)
    expect(first.body.title).toBe('轻云防晒外套')
    const review = submitContentVersionForReview(first)
    expect(review).toMatchObject({ ok: true, value: { state: 'review_required' } })
  })

  it('restoring v1 creates v3 and does not mutate v1 or v2', () => {
    const v1 = createContentVersion({ taskId: 'task_1', body, createdBy: 'actor_1', reason: 'initial' }, runtime())
    const v2 = createChildContentVersion(v1, { body: { ...body, title: 'v2' }, createdBy: 'actor_1', reason: 'edit', version: 2 }, runtime())
    if (!v2.ok) throw new Error('fixture v2 failed')
    const v3 = restoreContentVersion(v1, 3, 'actor_2', runtime())
    expect(v3.ok).toBe(true)
    if (!v3.ok) return
    expect(v3.value.parentId).toBe(v1.id)
    expect(v3.value.body).toEqual(v1.body)
    expect(v2.value.body.title).toBe('v2')
    expect(approveContentVersion(v1)).toMatchObject({ ok: false, error: { code: 'CONTENT_VERSION_INVALID' } })
  })
})

const publishFixture = () => {
  const rt = runtime()
  const token = issueConfirmationToken({ workspaceId: 'ws_1', platform: 'taobao', taskId: 'task_1', contentVersionId: 'cv_1', remoteSnapshotHash: 'remote_hash_1', confirmationHash: 'confirm_hash_1', expiresAt: '2026-08-22T11:00:00.000Z' }, rt)
  const repo = createInMemoryDomainRepository()
  const input = { workspaceId: 'ws_1', taskId: 'task_1', contentVersionId: 'cv_1', confirmationHash: 'confirm_hash_1', remoteSnapshotHash: 'remote_hash_1', idempotencyKey: 'idem_1' }
  return { rt, token, repo, input }
}

describe('PublishJob confirmation / idempotency / stale', () => {
  it('initializes both publish indexes in the in-memory repository contract', () => {
    const repo = createInMemoryDomainRepository()
    expect(repo.publishJobsByIdempotency).toBeInstanceOf(Map)
    expect(repo.publishJobsByToken).toBeInstanceOf(Map)
    expect(repo.publishJobsByToken.size).toBe(0)
  })

  it('creates one confirmed job and returns the same job for a duplicate idempotency key', () => {
    const { rt, token, repo, input } = publishFixture()
    const first = confirmPublish(token, input, repo.publishJobsByIdempotency, rt, repo.publishJobsByToken)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    repo.publishJobsByIdempotency.set(input.idempotencyKey, first.value)
    repo.publishJobsByToken.set(token.value, first.value)
    const second = confirmPublish(token, input, repo.publishJobsByIdempotency, rt, repo.publishJobsByToken)
    expect(second).toEqual(first)
  })

  it('rejects reused token under another idempotency key and conflicting idempotency intent', () => {
    const { rt, token, repo, input } = publishFixture()
    const first = confirmPublish(token, input, repo.publishJobsByIdempotency, rt, repo.publishJobsByToken)
    if (!first.ok) throw new Error('fixture publish failed')
    repo.publishJobsByIdempotency.set(input.idempotencyKey, first.value)
    repo.publishJobsByToken.set(token.value, first.value)
    expect(confirmPublish(token, { ...input, idempotencyKey: 'idem_2' }, repo.publishJobsByIdempotency, rt, repo.publishJobsByToken)).toMatchObject({ ok: false, error: { code: 'PUBLISH_CONFIRMATION_REPLAYED' } })
    expect(confirmPublish(token, { ...input, remoteSnapshotHash: 'other' }, repo.publishJobsByIdempotency, rt, repo.publishJobsByToken)).toMatchObject({ ok: false, error: { code: 'PUBLISH_IDEMPOTENCY_CONFLICT' } })
  })

  it('rejects stale and expired confirmations', () => {
    const { rt, repo, input } = publishFixture()
    const stale = issueConfirmationToken({ workspaceId: 'ws_1', platform: 'taobao', taskId: 'task_1', contentVersionId: 'cv_old', remoteSnapshotHash: 'remote_hash_old', confirmationHash: 'confirm_hash_old', expiresAt: '2026-08-22T11:00:00.000Z' }, rt)
    expect(confirmPublish(stale, input, repo.publishJobsByIdempotency, rt, repo.publishJobsByToken)).toMatchObject({ ok: false, error: { code: 'PUBLISH_CONFIRMATION_STALE' } })
    const expiredRuntime = runtime('2026-08-22T12:00:00.000Z')
    const expired = issueConfirmationToken({ workspaceId: 'ws_1', platform: 'taobao', taskId: 'task_1', contentVersionId: 'cv_1', remoteSnapshotHash: 'remote_hash_1', confirmationHash: 'confirm_hash_1', expiresAt: '2026-08-22T11:00:00.000Z' }, expiredRuntime)
    expect(confirmPublish(expired, input, repo.publishJobsByIdempotency, expiredRuntime, repo.publishJobsByToken)).toMatchObject({ ok: false, error: { code: 'PUBLISH_CONFIRMATION_EXPIRED' } })
  })

  it('requires reconciliation before an unknown job can move on', () => {
    const { rt, token, repo, input } = publishFixture()
    const created = confirmPublish(token, input, repo.publishJobsByIdempotency, rt, repo.publishJobsByToken)
    if (!created.ok) throw new Error('fixture publish failed')
    const queued = transitionPublishJob(created.value, 'queued')
    if (!queued.ok) throw new Error('fixture queue failed')
    const submitting = transitionPublishJob(queued.value, 'submitting')
    if (!submitting.ok) throw new Error('fixture submit failed')
    const unknown = transitionPublishJob(submitting.value, 'unknown')
    if (!unknown.ok) throw new Error('fixture unknown failed')
    expect(retryPublishJob(unknown.value)).toMatchObject({ ok: false, error: { code: 'PUBLISH_UNKNOWN_REQUIRES_RECONCILIATION' } })
    const reconciling = startReconciliation(unknown.value)
    expect(reconciling.ok).toBe(true)
    if (!reconciling.ok) return
    expect(reconcilePublishJob(reconciling.value, 'published')).toMatchObject({ ok: true, value: { state: 'published' } })
    expect(reconcilePublishJob(reconciling.value, 'absent')).toMatchObject({ ok: true, value: { state: 'manual_attention' } })
  })
})
