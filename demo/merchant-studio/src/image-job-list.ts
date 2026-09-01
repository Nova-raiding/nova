import type { ImageGenerationJobListItem } from './api'

/**
 * Preserve the desktop list's visual order while applying a fresh server
 * snapshot. The API may sort by updated_at, but a refresh should not make
 * rows jump around under the user's pointer or keyboard focus.
 */
export function mergeImageGenerationJobs(
  previous: readonly ImageGenerationJobListItem[],
  next: readonly ImageGenerationJobListItem[],
): ImageGenerationJobListItem[] {
  const byId = new Map(next.map(job => [job.jobId, job]))
  const stableExisting = previous
    .map(job => byId.get(job.jobId))
    .filter((job): job is ImageGenerationJobListItem => Boolean(job))
  const existingIds = new Set(previous.map(job => job.jobId))
  const newJobs = next.filter(job => !existingIds.has(job.jobId))
  return [...stableExisting, ...newJobs]
}
