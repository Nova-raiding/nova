export const IMAGE_CANDIDATE_PAGE_SIZE = 50

export type ImageCandidatePage<T> = {
  items: T[]
  page: number
  pageCount: number
  total: number
}

/** Keep large candidate galleries bounded without changing candidate identity. */
export function getImageCandidatePage<T>(items: T[], requestedPage: number, pageSize = IMAGE_CANDIDATE_PAGE_SIZE): ImageCandidatePage<T> {
  const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : IMAGE_CANDIDATE_PAGE_SIZE
  const pageCount = Math.max(1, Math.ceil(items.length / safePageSize))
  const page = Math.min(Math.max(1, Math.floor(requestedPage) || 1), pageCount)
  const start = (page - 1) * safePageSize
  return { items: items.slice(start, start + safePageSize), page, pageCount, total: items.length }
}
