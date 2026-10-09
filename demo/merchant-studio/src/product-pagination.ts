export function clampProductPage(page: number, total: number, pageSize: number): number {
  if (!Number.isFinite(page) || !Number.isFinite(total) || !Number.isFinite(pageSize) || pageSize <= 0) return 0
  const lastPage = Math.max(0, Math.ceil(Math.max(0, total) / pageSize) - 1)
  return Math.min(Math.max(0, Math.floor(page)), lastPage)
}
