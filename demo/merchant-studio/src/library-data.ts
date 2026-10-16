export type LibraryDataMode = 'unconfigured' | 'loading' | 'api_error' | 'api_empty' | 'api_ready'

export function resolveLibraryData<T>({
  baseUrl,
  remote,
  error,
}: {
  baseUrl?: string
  remote: T[] | null
  error: string
  fixtures?: T[]
}): { mode: LibraryDataMode; items: T[] } {
  if (!baseUrl) return { mode: 'unconfigured', items: [] }
  if (error) return { mode: 'api_error', items: [] }
  if (remote === null) return { mode: 'loading', items: [] }
  if (remote.length === 0) return { mode: 'api_empty', items: [] }
  return { mode: 'api_ready', items: remote }
}
