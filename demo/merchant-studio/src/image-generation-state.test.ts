import { describe, expect, it } from 'vitest'
import { imageGenerationDisplayState, imageGenerationExecutionLabel, imageGenerationNeedsReconciliation, imageGenerationProviderCallStarted, imageGenerationRetryAllowed, isImageGenerationConfigurationError } from './image-generation-state'

describe('image generation execution presentation', () => {
  it('uses explicit desktop-safe labels for provider lifecycle states', () => {
    expect(imageGenerationExecutionLabel('provider_reserved')).toContain('锁定模型请求')
    expect(imageGenerationExecutionLabel('provider_dispatching')).toContain('提交模型请求')
    expect(imageGenerationExecutionLabel('provider_started')).toContain('已受理')
    expect(imageGenerationExecutionLabel('outcome_unknown')).toContain('禁止重复生成')
    expect(imageGenerationExecutionLabel('provider_added_later')).toBe('状态待确认，请刷新或进入对账')
  })

  it('requires reconciliation for unknown outcomes and never permits retry', () => {
    expect(imageGenerationNeedsReconciliation('outcome_unknown')).toBe(true)
    expect(imageGenerationProviderCallStarted('provider_reserved')).toBe(false)
    expect(imageGenerationProviderCallStarted('provider_dispatching')).toBe(true)
    expect(imageGenerationProviderCallStarted('provider_started')).toBe(true)
    expect(imageGenerationRetryAllowed({ state: 'failed', executionState: 'outcome_unknown', nextActionAllowed: true })).toBe(false)
    expect(imageGenerationRetryAllowed({ state: 'failed', executionState: 'provider_reserved', nextActionAllowed: true })).toBe(false)
    expect(imageGenerationRetryAllowed({ state: 'failed', executionState: 'provider_dispatching', nextActionAllowed: true })).toBe(false)
    expect(imageGenerationRetryAllowed({ state: 'failed', executionState: 'provider_started', nextActionAllowed: true })).toBe(false)
    expect(imageGenerationRetryAllowed({ state: 'failed', executionState: 'failed', nextActionAllowed: true })).toBe(true)
  })

  it('classifies relay configuration failures without widening the blocker to generic 503s', () => {
    expect(isImageGenerationConfigurationError({ status: 503, code: 'MODEL_RELAY_NOT_CONFIGURED' })).toBe(true)
    expect(isImageGenerationConfigurationError({ status: 503, code: 'IMAGE_GENERATION_NOT_CONFIGURED' })).toBe(true)
    expect(isImageGenerationConfigurationError({ status: 503, code: 'IMAGE_GENERATION_READ_UNAVAILABLE' })).toBe(false)
    expect(isImageGenerationConfigurationError({ status: 503, code: 'STORE_ONBOARDING_REQUIRED' })).toBe(false)
    expect(isImageGenerationConfigurationError({ status: 500, code: 'MODEL_RELAY_NOT_CONFIGURED' })).toBe(false)
  })
})

describe('image generation headline state', () => {
  it('keeps uncertain and in-flight provider outcomes ahead of pending archive', () => {
    for (const executionState of ['outcome_unknown', 'provider_reserved', 'provider_dispatching', 'provider_started', 'dispatching']) {
      expect(imageGenerationDisplayState({ state: 'running', archiveState: 'pending', executionState })).toBe(executionState)
    }
  })
  it('shows archive progress only after provider execution is no longer pending', () => {
    expect(imageGenerationDisplayState({ state: 'succeeded', executionState: 'succeeded', archiveState: 'pending' })).toBe('archiving')
    expect(imageGenerationDisplayState({ state: 'succeeded', archiveState: 'archived' })).toBe('succeeded')
    expect(imageGenerationDisplayState({ state: 'succeeded', archiveState: 'partial' })).toBe('partial_archive')
    expect(imageGenerationDisplayState(null)).toBe('')
  })
})
