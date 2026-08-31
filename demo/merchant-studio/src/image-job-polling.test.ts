import { describe, expect, it } from 'vitest'
import { nextImageJobPollDelay, shouldPollImageJob, visibleImageJobPollDelay } from './image-job-polling'

describe('image job polling policy', () => {
  it('continues through archiving and stops only at a terminal deliverable state', () => {
    expect(shouldPollImageJob({ state: 'succeeded', archiveState: 'pending' })).toBe(true)
    expect(shouldPollImageJob({ state: 'succeeded', archiveState: 'partial' })).toBe(true)
    expect(shouldPollImageJob({ state: 'succeeded', archiveState: 'archived' })).toBe(false)
    expect(shouldPollImageJob({ state: 'failed', archiveState: 'external_unarchived' })).toBe(false)
  })

  it('resets after success and backs off errors without exceeding 30 seconds', () => {
    expect(nextImageJobPollDelay(5_000, 'success')).toBe(5_000)
    expect(nextImageJobPollDelay(5_000, 'error')).toBe(10_000)
    expect(nextImageJobPollDelay(10_000, 'error')).toBe(20_000)
    expect(nextImageJobPollDelay(20_000, 'error')).toBe(30_000)
    expect(nextImageJobPollDelay(30_000, 'error')).toBe(30_000)
  })

  it('slows hidden tabs to the maximum interval', () => {
    expect(visibleImageJobPollDelay(5_000, true)).toBe(30_000)
    expect(visibleImageJobPollDelay(60_000, false)).toBe(30_000)
  })
})
