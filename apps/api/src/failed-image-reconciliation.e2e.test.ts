import { afterEach, describe, expect, it, vi } from 'vitest'
import { CreativePointRepositoryError, MemoryCreativePointRepository } from '../../../packages/persistence/src/creative-point-repository.js'
import { MemoryImageGenerationExecutionRepository } from '../../../packages/persistence/src/image-generation-execution-repository.js'
import { MemoryReconciliationStatusRepository } from '../../../packages/persistence/src/reconciliation-status-repository.js'
import type { OutboxEvent } from '../../../packages/persistence/src/repository.js'
import { persistenceReady, server, service, setFailedImageReconciliationPersistenceForTests } from './server.js'

const cleanups: Array<() => void> = []

async function start() {
  await persistenceReady
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  while (cleanups.length) cleanups.pop()!()
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  vi.unstubAllEnvs()
})

async function fixture(successReceipt = false, commercialSnapshot = true, executionState: 'failed' | 'provider_started' | 'outcome_unknown' | 'not_started' = 'failed') {
  const workspaceId = `ws_failed_image_${crypto.randomUUID()}`
  const actionId = `image:${crypto.randomUUID()}`
  const points = new MemoryCreativePointRepository()
  await points.grant({ workspaceId, idempotencyKey: `grant:${workspaceId}`, sourceType: 'test', sourceId: workspaceId, points: 10 })
  const reservation = (await points.reserve({ workspaceId, idempotencyKey: `reserve:${workspaceId}`, actionKey: actionId, points: 3, rateCardVersion: 'image-v1' })).value
  const pointPort = points as MemoryCreativePointRepository & { releaseFailedProviderReservation: NonNullable<import('../../../packages/persistence/src/creative-point-repository.js').CreativePointRepository['releaseFailedProviderReservation']> }
  pointPort.releaseFailedProviderReservation = async input => {
    if (successReceipt || (input.preProvider !== true && !input.providerRequestId?.startsWith('provider_'))) throw new CreativePointRepositoryError('CREATIVE_POINT_BALANCE_UNKNOWN', 'failed provider receipt is unavailable')
    return points.release(input)
  }
  const product = service.importProduct({ workspaceId, platform: 'taobao', title: '失败图片收口测试商品' })
  const job = service.enqueueImageGeneration({ workspaceId, productId: product.id, idempotencyKey: `job:${workspaceId}` })
  const event: OutboxEvent = { id: `event_${crypto.randomUUID()}`, workspaceId, aggregateId: job.id, eventType: 'image.generation.requested', sequence: 1, payload: { action_id: actionId, ...(commercialSnapshot ? { commercial_access_snapshot: { access_mode: 'POINT_CHARGED', reservation_id: reservation.id, quoted_points: 3, rate_version: 'image-v1' } } : {}) }, ...(executionState === 'not_started' ? { lastError: { terminal: true, unknown: false, code: 'AUTHZ_EXECUTION_RECHECK_DENIED' } } : {}), createdAt: new Date().toISOString() }
  const executions = new MemoryImageGenerationExecutionRepository()
  if (executionState !== 'not_started') {
    const claimed = await executions.claim({ workspaceId, jobId: job.id, eventId: event.id, leaseMs: 60_000 })
    await executions.reserveProviderOperation({ workspaceId, jobId: job.id, ownerToken: claimed.ownerToken })
    await executions.beginProviderDispatch({ workspaceId, jobId: job.id, ownerToken: claimed.ownerToken })
    await executions.markProviderStarted({ workspaceId, jobId: job.id, ownerToken: claimed.ownerToken, providerRequestId: `provider_${crypto.randomUUID()}` })
    if (executionState === 'failed') {
      await executions.markFailed({ workspaceId, jobId: job.id, ownerToken: claimed.ownerToken, errorCode: 'PROVIDER_REJECTED', errorMessage: 'provider rejected request' })
      service.markImageGenerationFailed({ workspaceId, jobId: job.id, errorCode: 'PROVIDER_REJECTED', errorMessage: 'provider rejected request' })
    } else if (executionState === 'outcome_unknown') {
      await executions.markOutcomeUnknown({ workspaceId, jobId: job.id, ownerToken: claimed.ownerToken, errorCode: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', errorMessage: 'provider outcome is unknown' })
    }
  }
  const events = [event]
  const outbox = { listAggregateEvents: vi.fn(async () => events) }
  const lifecycle = { hasSuccessfulProviderReceipt: vi.fn(async () => successReceipt) }
  const reconciliationStatuses = new MemoryReconciliationStatusRepository()
  cleanups.push(setFailedImageReconciliationPersistenceForTests({ creativePoints: pointPort, creativePointLifecycle: lifecycle as never, outbox: outbox as never, imageGenerationExecutions: executions, reconciliationStatuses }))
  return { workspaceId, actionId, job, reservation, points, event, events, reconciliationStatuses }
}

async function reconcile(base: string, workspaceId: string, jobId: string, idempotencyKey: string, expectedRevision?: number) {
  return fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId }, body: JSON.stringify({ jsonrpc: '2.0', id: idempotencyKey, method: 'ops.marketing.image.reconcile', params: { workspace_id: workspaceId, job_id: jobId, resolution: 'failed', evidence_ref: 'provider-rejection-receipt', reason: '运营核验执行与任务均失败且无交付归档', idempotency_key: idempotencyKey, ...(expectedRevision !== undefined ? { expected_revision: String(expectedRevision) } : {}) } }) }).then(response => response.json()) as Promise<{ data: { result?: Record<string, any> } | null; error: { code: string } | null }>
}

describe('failed image reconciliation API', () => {
  it('idempotently closes a failed execution/job and releases the original active reservation', async () => {
    const f = await fixture(false)
    const base = await start()
    const first = await reconcile(base, f.workspaceId, f.job.id, 'failed-close-1')
    expect(first.error).toBeNull()
    expect(first.data?.result).toMatchObject({ jobId: f.job.id, resolution: 'failed', recoveredProjection: true, creativePoints: { status: 'released', reservationId: f.reservation.id, points: 3 } })
    await expect(f.points.getReservation(f.workspaceId, f.reservation.id)).resolves.toMatchObject({ status: 'released' })
    const replay = await reconcile(base, f.workspaceId, f.job.id, 'failed-close-1')
    expect(replay.error).toBeNull()
    expect(replay.data?.result).toMatchObject({ status: 'failed', lastIdempotencyKey: 'failed-close-1' })
  })

  it('fails closed when the original commercial operation has any successful provider receipt', async () => {
    const f = await fixture(true)
    const base = await start()
    const response = await reconcile(base, f.workspaceId, f.job.id, 'failed-close-success-conflict')
    expect(response.data).toBeNull()
    expect(response.error).toMatchObject({ code: 'IMAGE_GENERATION_PROVIDER_FAILED_EVIDENCE_REQUIRED' })
    await expect(f.points.getReservation(f.workspaceId, f.reservation.id)).resolves.toMatchObject({ status: 'active' })
  })

  it('replays the same pre-provider release to recover when reconciliation status persistence fails', async () => {
    const f = await fixture(false, true, 'not_started')
    const base = await start()
    const expectedRevision = f.job.revision
    const persistStatus = f.reconciliationStatuses.upsert.bind(f.reconciliationStatuses)
    let rejectFirstWrite = true
    f.reconciliationStatuses.upsert = async input => {
      if (rejectFirstWrite) {
        rejectFirstWrite = false
        throw new Error('simulated reconciliation status write failure')
      }
      return persistStatus(input)
    }

    const first = await reconcile(base, f.workspaceId, f.job.id, 'preprovider-replay-after-status-failure', expectedRevision)
    expect(first.data).toBeNull()
    expect(first.error).toMatchObject({ code: 'INTERNAL_ERROR' })
    await expect(f.points.getReservation(f.workspaceId, f.reservation.id)).resolves.toMatchObject({ status: 'released' })
    expect(service.getImageGenerationJob(f.workspaceId, f.job.id)).toMatchObject({ state: 'failed', errorCode: 'IMAGE_GENERATION_MANUAL_FAILED' })

    // A retried operator command may get a new request id. The same immutable
    // source event must still replay the committed point release and finish
    // writing the reconciliation projection.
    const replay = await reconcile(base, f.workspaceId, f.job.id, 'preprovider-replay-after-status-failure-retry', expectedRevision)
    expect(replay.error).toBeNull()
    expect(replay.data?.result).toMatchObject({ jobId: f.job.id, resolution: 'failed', recoveredProjection: true, creativePoints: { status: 'released', reservationId: f.reservation.id, points: 3 } })
    await expect(f.points.getReservation(f.workspaceId, f.reservation.id)).resolves.toMatchObject({ status: 'released' })
    await expect(f.reconciliationStatuses.getLatest({ workspaceId: f.workspaceId, resourceType: 'image_generation_execution', resourceId: f.job.id })).resolves.toMatchObject({ status: 'failed', lastIdempotencyKey: 'preprovider-replay-after-status-failure-retry' })
  })

  it('rejects a failed projection bound to a different source event before releasing points', async () => {
    const f = await fixture(false, true, 'not_started')
    f.events.push({
      id: `failed_projection_${crypto.randomUUID()}`,
      workspaceId: f.workspaceId,
      aggregateId: f.job.id,
      eventType: 'image.generation.failed',
      sequence: 2,
      payload: { job_id: f.job.id, source_event_id: `other_request_${crypto.randomUUID()}` },
      createdAt: new Date().toISOString(),
    })
    const base = await start()
    const response = await reconcile(base, f.workspaceId, f.job.id, 'preprovider-wrong-source-event')
    expect(response.data).toBeNull()
    expect(response.error).toMatchObject({ code: 'IMAGE_GENERATION_PRE_PROVIDER_PROJECTION_CONFLICT' })
    await expect(f.points.getReservation(f.workspaceId, f.reservation.id)).resolves.toMatchObject({ status: 'active' })
  })

  it.each(['provider_started', 'outcome_unknown'] as const)(
    'does not release points when a %s execution has a successful provider receipt',
    async executionState => {
      const f = await fixture(true, true, executionState)
      const base = await start()
      const response = await reconcile(base, f.workspaceId, f.job.id, `failed-close-success-conflict-${executionState}`)
      expect(response.data).toBeNull()
      expect(response.error).toMatchObject({ code: 'IMAGE_GENERATION_PROVIDER_FAILED_EVIDENCE_REQUIRED' })
      await expect(f.points.getReservation(f.workspaceId, f.reservation.id)).resolves.toMatchObject({ status: 'active' })
      expect(f.job.state).toBe('queued')
    },
  )

  it.each(['provider_started', 'outcome_unknown'] as const)(
    'uses the evidence-bound release before the general reconcileFailed transition from %s',
    async executionState => {
      const f = await fixture(false, true, executionState)
      const base = await start()
      const response = await reconcile(base, f.workspaceId, f.job.id, `failed-close-${executionState}`)
      expect(response.error).toBeNull()
      expect(response.data?.result).toMatchObject({ resolution: 'failed', execution: { state: 'failed' }, reconciliation: { status: 'failed' } })
      await expect(f.points.getReservation(f.workspaceId, f.reservation.id)).resolves.toMatchObject({ status: 'released' })
      expect(service.getImageGenerationJob(f.workspaceId, f.job.id)).toMatchObject({ state: 'failed', errorCode: 'IMAGE_GENERATION_MANUAL_FAILED' })
    },
  )

  it('fails closed when the bound original outbox event has no commercial snapshot', async () => {
    const f = await fixture(false, false)
    const base = await start()
    const response = await reconcile(base, f.workspaceId, f.job.id, 'failed-close-no-snapshot')
    expect(response.data).toBeNull()
    expect(response.error).toMatchObject({ code: 'IMAGE_GENERATION_COMMERCIAL_SNAPSHOT_REQUIRED' })
    await expect(f.points.getReservation(f.workspaceId, f.reservation.id)).resolves.toMatchObject({ status: 'active' })
  })

  it('fails closed when no-execution recovery has multiple terminal requested events', async () => {
    const f = await fixture(false, true, 'not_started')
    f.events.push({ ...f.event, id: `event_second_terminal_${crypto.randomUUID()}`, sequence: f.event.sequence + 1 })
    const base = await start()
    const response = await reconcile(base, f.workspaceId, f.job.id, 'preprovider-ambiguous-terminal')
    expect(response.data).toBeNull()
    expect(response.error).toMatchObject({ code: 'IMAGE_GENERATION_PRE_PROVIDER_FAILURE_AMBIGUOUS' })
    await expect(f.points.getReservation(f.workspaceId, f.reservation.id)).resolves.toMatchObject({ status: 'active' })
  })

  it('releases only the terminal pre-provider event reservation when requested events are out of order', async () => {
    const workspaceId = `ws_preprovider_${crypto.randomUUID()}`
    const points = new MemoryCreativePointRepository()
    await points.grant({ workspaceId, idempotencyKey: `grant:${workspaceId}`, sourceType: 'test', sourceId: workspaceId, points: 10 })
    const staleAction = `image:stale:${crypto.randomUUID()}`
    const terminalAction = `image:terminal:${crypto.randomUUID()}`
    const staleReservation = (await points.reserve({ workspaceId, idempotencyKey: `reserve:stale:${workspaceId}`, actionKey: staleAction, points: 2, rateCardVersion: 'image-v1' })).value
    const terminalReservation = (await points.reserve({ workspaceId, idempotencyKey: `reserve:terminal:${workspaceId}`, actionKey: terminalAction, points: 3, rateCardVersion: 'image-v1' })).value
    const pointPort = points as MemoryCreativePointRepository & { releaseFailedProviderReservation: NonNullable<import('../../../packages/persistence/src/creative-point-repository.js').CreativePointRepository['releaseFailedProviderReservation']> }
    pointPort.releaseFailedProviderReservation = input => points.release(input)
    const product = service.importProduct({ workspaceId, platform: 'taobao', title: '终止事件绑定测试商品' })
    const job = service.enqueueImageGeneration({ workspaceId, productId: product.id, idempotencyKey: `job:${workspaceId}` })
    const event = (id: string, actionId: string, reservationId: string, terminal: boolean): OutboxEvent => ({ id, workspaceId, aggregateId: job.id, eventType: 'image.generation.requested', sequence: terminal ? 2 : 1, payload: { action_id: actionId, commercial_access_snapshot: { access_mode: 'POINT_CHARGED', reservation_id: reservationId } }, ...(terminal ? { lastError: { terminal: true, unknown: false, code: 'COMMERCIAL_EXECUTION_DENIED' } } : {}), createdAt: new Date().toISOString() })
    const stale = event(`event_stale_${crypto.randomUUID()}`, staleAction, staleReservation.id, false)
    const terminal = event(`event_terminal_${crypto.randomUUID()}`, terminalAction, terminalReservation.id, true)
    const outbox = { listAggregateEvents: vi.fn(async () => [stale, terminal]) }
    const lifecycle = { hasSuccessfulProviderReceipt: vi.fn(async () => false) }
    cleanups.push(setFailedImageReconciliationPersistenceForTests({ creativePoints: pointPort, creativePointLifecycle: lifecycle as never, outbox: outbox as never, imageGenerationExecutions: new MemoryImageGenerationExecutionRepository(), reconciliationStatuses: new MemoryReconciliationStatusRepository() }))
    const base = await start()
    const response = await reconcile(base, workspaceId, job.id, 'preprovider-terminal-event')
    expect(response.error).toBeNull()
    expect(response.data?.result).toMatchObject({ creativePoints: { status: 'released', reservationId: terminalReservation.id } })
    await expect(points.getReservation(workspaceId, staleReservation.id)).resolves.toMatchObject({ status: 'active' })
    await expect(points.getReservation(workspaceId, terminalReservation.id)).resolves.toMatchObject({ status: 'released' })
  })
})
