import { describe, expect, it } from 'vitest'
import { projectImageGenerationActions } from './image-generation-action-contract.js'

describe('image generation state action contract', () => {
  it('keeps unknown and provider states reconciliation-only', () => {
    for (const state of ['unknown', 'provider_started', 'provider_dispatching', 'outcome_unknown']) {
      const result = projectImageGenerationActions({ state, nextActionAllowed: true })
      expect(result.primaryAction).toBe(state === 'provider_started' || state === 'provider_dispatching' || state === 'outcome_unknown' ? 'query_provider' : 'refresh_status')
      expect(result.retryAllowed).toBe(false)
      expect(result.publishable).toBe(false)
      expect(result.allowedActions).not.toContain('retry_generation')
    }
  })

  it('uses archive and scan recovery actions without declaring success', () => {
    expect(projectImageGenerationActions({ state: 'archiving' })).toMatchObject({ primaryAction: 'review_archive', reconciliationRequired: true, publishable: false })
    expect(projectImageGenerationActions({ state: 'failed', archiveState: 'partial', nextActionAllowed: true })).toMatchObject({ primaryAction: 'review_archive', retryAllowed: false })
    expect(projectImageGenerationActions({ state: 'scan_pending' })).toMatchObject({ primaryAction: 'wait_for_scan', publishable: false })
    expect(projectImageGenerationActions({ state: 'quarantined' })).toMatchObject({ primaryAction: 'wait_for_scan', publishable: false })
    expect(projectImageGenerationActions({ state: 'failed', scanStatus: 'blocked' })).toMatchObject({ primaryAction: 'resolve_scan', retryAllowed: false })
  })

  it('permits retry only for explicit pre-provider failures', () => {
    expect(projectImageGenerationActions({ state: 'failed', providerAttemptState: 'not_started', errorCode: 'IMAGE_GENERATION_PRE_PROVIDER_FAILED', nextActionAllowed: true })).toMatchObject({ primaryAction: 'retry_generation', retryAllowed: true })
    expect(projectImageGenerationActions({ state: 'failed', providerAttemptState: 'started', errorCode: 'IMAGE_GENERATION_PRE_PROVIDER_FAILED', nextActionAllowed: true }).retryAllowed).toBe(false)
    expect(projectImageGenerationActions({ state: 'failed', providerAttemptState: 'not_started', errorCode: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', nextActionAllowed: true }).retryAllowed).toBe(false)
  })

  it('keeps archived candidates non-publishable without clean scan evidence', () => {
    expect(projectImageGenerationActions({ state: 'archived', scanStatus: 'pending' })).toMatchObject({ publishable: false })
    expect(projectImageGenerationActions({ state: 'archived', scanStatus: 'clean' })).toMatchObject({ publishable: true, primaryAction: 'none' })
  })
})
