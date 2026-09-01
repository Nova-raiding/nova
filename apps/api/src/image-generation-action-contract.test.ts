import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { projectImageGenerationActions } from '../../../packages/application/src/image-generation-action-contract.js'

const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')

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

    const admission = generate.slice(generate.indexOf("if (process.env.IMAGE_GENERATION_EXECUTION_MODE"))
    expect(admission.indexOf('IMAGE_GENERATION_DURABLE_NOT_CONFIGURED')).toBeLessThan(admission.indexOf("return result({ job_id"))
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
})
