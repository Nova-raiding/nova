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
  const retainedIds = new Set<string>()
  const stableExisting = previous
    .map(job => byId.get(job.jobId))
    .filter((job): job is ImageGenerationJobListItem => {
      if (!job || retainedIds.has(job.jobId)) return false
      retainedIds.add(job.jobId)
      return true
    })
  const newJobs = next.filter(job => {
    if (retainedIds.has(job.jobId)) return false
    retainedIds.add(job.jobId)
    return true
  })
  return [...stableExisting, ...newJobs]
}
