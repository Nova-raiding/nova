import { describe, expect, it } from 'vitest'
import { mergeImageGenerationJobs } from './image-job-list'
import type { ImageGenerationJobListItem } from './api'

const job = (jobId: string, updatedAt: string): ImageGenerationJobListItem => ({
  jobId,
  productId: `product-${jobId}`,
  revision: 1,
  state: 'running',
  archiveState: 'pending',
  executionState: 'provider_started',
  updatedAt,
  candidateCount: 0,
})

describe('image generation desktop list refresh', () => {
  it('keeps existing rows stable when the server changes its sort order', () => {
    const first = job('job-a', '2026-09-01T00:00:01.000Z')
    const second = job('job-b', '2026-09-01T00:00:02.000Z')
    const refreshedFirst = { ...first, updatedAt: '2026-09-01T00:00:03.000Z' }

    expect(mergeImageGenerationJobs([first, second], [second, refreshedFirst])).toEqual([
      refreshedFirst,
      second,
    ])
  })

  it('removes missing jobs and appends newly discovered jobs without disturbing focus order', () => {
    const first = job('job-a', '2026-09-01T00:00:01.000Z')
    const second = job('job-b', '2026-09-01T00:00:02.000Z')
    const third = job('job-c', '2026-09-01T00:00:03.000Z')

    expect(mergeImageGenerationJobs([first, second], [third, second])).toEqual([second, third])
  })

  it('deduplicates repeated server rows so refresh cannot render duplicate job IDs', () => {
    const first = job('job-a', '2026-09-01T00:00:01.000Z')
    const second = job('job-b', '2026-09-01T00:00:02.000Z')

    expect(mergeImageGenerationJobs([], [first, first, second, second])).toEqual([first, second])
    expect(mergeImageGenerationJobs([first, first], [second, first, first])).toEqual([first, second])
  })
})
