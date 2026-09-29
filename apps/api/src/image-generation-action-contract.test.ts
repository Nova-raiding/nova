import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { projectImageGenerationActions } from '../../../packages/application/src/image-generation-action-contract.js'
import { durableImageAdmissionCommitted, prepareDurableImageAdmission } from './mcp-image-handlers.js'

const source = readFileSync(new URL('./mcp-image-handlers.ts', import.meta.url), 'utf8')

describe('image generation API action contract', () => {
  it('fails closed when durable image execution is not configured', () => {
    const generateStart = source.indexOf("case 'catalog.image.generate':")
    const retryStart = source.indexOf("case 'catalog.image.retry':")
    expect(generateStart).toBeGreaterThanOrEqual(0)
    expect(retryStart).toBeGreaterThan(generateStart)

    const generate = source.slice(generateStart, retryStart)
    const retry = source.slice(retryStart, source.indexOf("case 'catalog.image.get':", retryStart))
    for (const route of [generate, retry]) {
      expect(route).toContain("process.env.IMAGE_GENERATION_EXECUTION_MODE?.trim().toLowerCase() === 'durable'")
      expect(route).toContain('persistence.persistSnapshotAndEvent')
      expect(route).toContain('persistence.outbox')
      expect(route).toContain('persistence.imageGenerationExecutions')
      expect(route).toContain("IMAGE_GENERATION_DURABLE_NOT_CONFIGURED")
    }

    const admission = generate.slice(generate.indexOf('const durableImageGeneration'))
    expect(admission.indexOf('IMAGE_GENERATION_DURABLE_NOT_CONFIGURED')).toBeLessThan(admission.indexOf("return ({ job_id"))
    // Configuration failure must happen before any creative-point reservation;
    // otherwise a failed enqueue can strand an active reservation.
    expect(generate.indexOf('const durableImageGeneration')).toBeGreaterThanOrEqual(0)
    expect(generate.indexOf('IMAGE_GENERATION_DURABLE_NOT_CONFIGURED')).toBeGreaterThanOrEqual(0)
    expect(generate.indexOf('IMAGE_GENERATION_DURABLE_NOT_CONFIGURED')).toBeLessThan(generate.indexOf('await reserveCreativePointsForModel(workspaceId, walletDebitKey, commercialDecision)'))
  })

  it('does not tell a terminal durable image job to continue automatic polling', () => {
    expect(source).toContain("const stillRunning = job.state === 'queued' || job.state === 'running'")
    expect(source).toContain("job.state === 'failed'\n            ? { type: 'review_error'")
    expect(source).toContain("job.state === 'succeeded'\n              ? { type: 'review_candidates'")
    expect(source).toContain('automatic: stillRunning, user_action_required: false, next_action: nextAction')
  })

  it('repairs an in-memory image enqueue when durable snapshot or outbox admission previously failed', () => {
    expect(source).toContain("event.eventType === 'image.generation.requested' && event.payload.idempotency_key === idempotencyKey")
    expect(source).toContain('if (!durableAdmissionExists)')
    expect(source).toContain('getReservationByActionKey?.(workspaceId, walletDebitKey)')
    expect(source).toContain("eventType: 'image.generation.requested', eventPayload: prepared.guardedEventPayload")
    expect(durableImageAdmissionCommitted([
      { eventType: 'image.generation.requested', payload: { idempotency_key: 'same-request' } },
    ], 'same-request')).toBe(true)
    expect(durableImageAdmissionCommitted([
      { eventType: 'image.generation.requested', payload: { idempotency_key: 'different-request' } },
      { eventType: 'image.generation.completed', payload: { idempotency_key: 'same-request' } },
    ], 'same-request')).toBe(false)
  })

  it.each(['authorization snapshot', 'source asset read'])('compensates a %s failure before durable dispatch', async failurePoint => {
    const releaseReservation = vi.fn(async () => undefined)
    const refundLegacyDebit = vi.fn(async () => undefined)
    const discardQueuedJob = vi.fn()
    const writeOutboxAdmission = vi.fn()
    const callProvider = vi.fn()
    const injectedFailure = new Error(`injected ${failurePoint} failure`)

    await expect(prepareDurableImageAdmission(async () => {
      if (failurePoint === 'authorization snapshot') throw injectedFailure
      await Promise.reject(injectedFailure)
      return { authorizationSnapshot: 'trusted', sourceAssetDataUrls: [] }
    }, async () => {
      await releaseReservation()
      await refundLegacyDebit()
      discardQueuedJob()
    })).rejects.toBe(injectedFailure)

    expect(releaseReservation).toHaveBeenCalledOnce()
    expect(refundLegacyDebit).toHaveBeenCalledOnce()
    expect(discardQueuedJob).toHaveBeenCalledOnce()
    expect(writeOutboxAdmission).not.toHaveBeenCalled()
    expect(callProvider).not.toHaveBeenCalled()

    const generate = source.slice(source.indexOf("case 'catalog.image.generate':"), source.indexOf("case 'catalog.image.retry':"))
    expect(generate.indexOf('const prepared = await prepareDurableImageAdmission')).toBeGreaterThanOrEqual(0)
    expect(generate.indexOf('await persistence.persistSnapshotAndEvent')).toBeGreaterThan(generate.indexOf('const prepared = await prepareDurableImageAdmission'))
    expect(generate).toContain('if (existingImageJob) return')
    expect(generate).toContain('service.discardUnpersistedImageGeneration(workspaceId, job.id)')
    expect(generate.indexOf('service.discardUnpersistedImageGeneration(workspaceId, job.id)')).toBeLessThan(generate.indexOf("await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: walletDebitKey, actorId: billingActorId, reason: '图片任务入队准备失败' })"))
  })

  it('does not compensate after durable persistence begins because commit outcome may be unknown', () => {
    const generate = source.slice(source.indexOf("case 'catalog.image.generate':"), source.indexOf("case 'catalog.image.retry':"))
    const prepareStart = generate.indexOf('const prepared = await prepareDurableImageAdmission')
    const persist = generate.indexOf('await persistence.persistSnapshotAndEvent')
    const cleanup = generate.indexOf('await releaseReservedModelPoints(workspaceId, walletDebitKey, \'图片任务入队准备失败\'')
    expect(cleanup).toBeGreaterThan(prepareStart)
    expect(cleanup).toBeLessThan(persist)
    expect(generate.slice(persist)).not.toContain('releaseReservedModelPoints(workspaceId, walletDebitKey, \'图片任务入队准备失败\'')
  })

  it('keeps unknown and provider-started outcomes non-retryable and non-publishable', () => {
    for (const state of ['unknown', 'outcome_unknown', 'provider_started', 'provider_dispatching'] as const) {
      const projection = projectImageGenerationActions({ state, providerAttemptState: 'unknown', nextActionAllowed: true })
      expect(projection.retryAllowed).toBe(false)
      expect(projection.publishable).toBe(false)
      expect(projection.allowedActions).not.toContain('retry_generation')
      expect(projection.reconciliationRequired).toBe(true)
    }

    const retryRoute = source.slice(source.indexOf("case 'catalog.image.retry':"), source.indexOf("case 'catalog.image.get':"))
    expect(retryRoute).toContain('service.retryImageGeneration')
    expect(retryRoute).toContain('imageRunKey')
    expect(retryRoute).toContain('expectedRevision')
  })

  it('requires scan completion before exposing or publishing generated candidates', () => {
    expect(projectImageGenerationActions({ state: 'scan_pending' })).toMatchObject({
      primaryAction: 'wait_for_scan',
      retryAllowed: false,
      publishable: false,
    })
    expect(projectImageGenerationActions({ state: 'quarantined' })).toMatchObject({
      primaryAction: 'wait_for_scan',
      retryAllowed: false,
      publishable: false,
    })
    expect(projectImageGenerationActions({ state: 'archived', scanStatus: 'quarantined' })).toMatchObject({
      retryAllowed: false,
      publishable: false,
    })

    const getRoute = source.slice(source.indexOf("case 'catalog.image.get':"), source.indexOf("case 'catalog.image.select':"))
    expect(getRoute).toContain('imageJobOutputsAreClean')
    expect(getRoute).toContain('availabilityWarning')
    expect(getRoute).toContain('不会返回图片内容')
  })

  it('makes a repeated retry idempotent without a second debit or generation', () => {
    const retryStart = source.indexOf("case 'catalog.image.retry':")
    const retryEnd = source.indexOf("case 'catalog.image.get':", retryStart)
    const retry = source.slice(retryStart, retryEnd)
    const existingRetry = retry.indexOf('const existingRetry =')
    const billing = retry.indexOf('if (!existingRetry)')
    const retryCall = retry.indexOf('service.retryImageGeneration')
    expect(existingRetry).toBeGreaterThanOrEqual(0)
    expect(billing).toBeGreaterThan(existingRetry)
    expect(retryCall).toBeGreaterThan(billing)
    expect(retry).toContain('candidate.workspaceId === workspaceId')
    expect(retry).toContain('candidate.idempotencyKey === retryKey')
    expect(retry).toContain('alreadyExists')
    expect(retry).toContain('if (!retried.alreadyExists)')
    expect(retry).toContain('idempotency_key: retryKey')
    expect(retry).toContain("enforceMcpCommercialAccess(req, workspaceId, 'catalog.image.generate')")
    expect(retry).toContain('reserveCreativePointsForModel(workspaceId, walletDebitKey, commercialDecision)')
    expect(retry).toContain('releaseReservedModelPoints(workspaceId, walletDebitKey')

    const safePreProvider = projectImageGenerationActions({
      state: 'failed',
      providerAttemptState: 'not_started',
      errorCode: 'IMAGE_GENERATION_PRE_PROVIDER_FAILED',
      nextActionAllowed: true,
    })
    expect(safePreProvider).toMatchObject({ primaryAction: 'retry_generation', retryAllowed: true })
    expect(projectImageGenerationActions({
      state: 'failed',
      providerAttemptState: 'started',
      errorCode: 'IMAGE_GENERATION_PRE_PROVIDER_FAILED',
      nextActionAllowed: true,
    }).retryAllowed).toBe(false)
  })

  it('reserves creative points before returning balance evidence, including gifted points', () => {
    const generateStart = source.indexOf("case 'catalog.image.generate':")
    const retryStart = source.indexOf("case 'catalog.image.retry':", generateStart)
    const generate = source.slice(generateStart, retryStart)
    const reservation = generate.indexOf('await reserveCreativePointsForModel(workspaceId, walletDebitKey, commercialDecision)')
    const evidence = generate.indexOf('creativePoints = await imageCreativePointsEvidence')
    expect(reservation).toBeGreaterThanOrEqual(0)
    expect(evidence).toBeGreaterThan(reservation)
    expect(generate).toContain('const creativeReservation = billingRequired')
    expect(generate).toContain("state: job.state")
    expect(generate).toContain("automatic: stillRunning, user_action_required: false, next_action: nextAction")
    const serverSource = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
    expect(serverSource).toContain('getReservationByActionKey')
    expect(serverSource).toContain('deducted_points: reservation?.status === \'settled\'')
    expect(serverSource).toContain('point_reservation_points: reservation?.points ?? null')
  })

  it('returns the existing image job receipt on idempotent generation and retry replays', () => {
    const generateStart = source.indexOf("case 'catalog.image.generate':")
    const retryStart = source.indexOf("case 'catalog.image.retry':", generateStart)
    const getStart = source.indexOf("case 'catalog.image.get':", retryStart)
    const generate = source.slice(generateStart, retryStart)
    const retry = source.slice(retryStart, getStart)

    const existingJob = generate.indexOf('const existingImageJob =')
    const billingRequired = generate.indexOf('const billingRequired =')
    const reservation = generate.indexOf('await reserveCreativePointsForModel(workspaceId, walletDebitKey, commercialDecision)')
    expect(existingJob).toBeGreaterThanOrEqual(0)
    expect(billingRequired).toBeGreaterThan(existingJob)
    expect(reservation).toBeGreaterThan(billingRequired)
    expect(generate.slice(billingRequired, reservation)).toContain('!existingImageJob')
    expect(generate.slice(billingRequired, reservation + 120)).toContain('const creativeReservation = billingRequired')
    const continuationSettled = generate.indexOf("existingImageJob.continuation.billingState = 'settled'")
    const continuationPersisted = generate.indexOf("await persistSnapshot(workspaceId, 'image_generation_job', existingImageJob")
    expect(continuationSettled).toBeGreaterThan(reservation)
    expect(continuationPersisted).toBeGreaterThan(continuationSettled)

    const existingRetry = retry.indexOf('const existingRetry =')
    const retryReservation = retry.indexOf('await reserveCreativePointsForModel(workspaceId, walletDebitKey, commercialDecision)')
    expect(existingRetry).toBeGreaterThanOrEqual(0)
    expect(retryReservation).toBeGreaterThan(existingRetry)
    expect(retry.slice(existingRetry, retryReservation + 120)).toContain('const creativeReservation = existingRetry')
    expect(retry).toContain('else if (!existingRetry) await refundPluginWalletDebit')
    expect(retry).toContain('const retryState = retried.job.state')
    expect(retry).toContain("automatic: retryState === 'queued' || retryState === 'running'")
  })
})
