import type { ImageGenerationJob } from './api'

export const IMAGE_JOB_INITIAL_POLL_DELAY_MS = 5_000
export const IMAGE_JOB_MAX_POLL_DELAY_MS = 30_000

export function shouldPollImageJob(job: Pick<ImageGenerationJob, 'state' | 'archiveState'>) {
  return !(job.state === 'failed' || (job.state === 'succeeded' && job.archiveState === 'archived'))
}

export function nextImageJobPollDelay(currentDelayMs: number, outcome: 'success' | 'error') {
  if (outcome === 'success') return IMAGE_JOB_INITIAL_POLL_DELAY_MS
  return Math.min(Math.max(IMAGE_JOB_INITIAL_POLL_DELAY_MS, currentDelayMs) * 2, IMAGE_JOB_MAX_POLL_DELAY_MS)
}

export function visibleImageJobPollDelay(delayMs: number, hidden: boolean) {
  return hidden ? IMAGE_JOB_MAX_POLL_DELAY_MS : Math.min(Math.max(IMAGE_JOB_INITIAL_POLL_DELAY_MS, delayMs), IMAGE_JOB_MAX_POLL_DELAY_MS)
}
