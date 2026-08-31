import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AuditCenterDetail,
  AuditCenterExport,
  AuditCenterPage,
  AuditCenterQuery,
  AuditCenterRecord,
  AuditSource,
} from '../../../../packages/contracts/src/ops/audit-center.js'

/** Matches the three canonical AuditCenterService operations. */
export interface AuditCenterClient {
  list(query: AuditCenterQuery, signal?: AbortSignal): Promise<AuditCenterPage>
  listPlatform?(query: AuditCenterFilters, signal?: AbortSignal): Promise<AuditCenterPage>
  detail(input: { workspaceId: string; source: AuditSource; id: string }, signal?: AbortSignal): Promise<AuditCenterDetail>
  exportCsv(query: AuditCenterQuery, signal?: AbortSignal): Promise<AuditCenterExport>
}

export type AuditCenterFilters = Omit<AuditCenterQuery, 'workspaceId' | 'cursor' | 'limit'>

export const mergeAuditRecords = (
  current: readonly AuditCenterRecord[],
  incoming: readonly AuditCenterRecord[],
) => {
  const seen = new Set(current.map(item => `${item.source}:${item.id}`))
  return [...current, ...incoming.filter(item => !seen.has(`${item.source}:${item.id}`))]
}

export const buildAuditCenterQuery = (
  workspaceId: string,
  filters: AuditCenterFilters,
  cursor?: string,
  limit = 50,
): AuditCenterQuery => ({ workspaceId, ...filters, ...(cursor ? { cursor } : {}), limit })

const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback

export function useAuditCenter(client: AuditCenterClient, workspaceId: string, autoLoad = true, platformScope = false) {
  const [filters, setFiltersState] = useState<AuditCenterFilters>({})
  const [records, setRecords] = useState<AuditCenterRecord[]>([])
  const [totalRecords, setTotalRecords] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [nextCursor, setNextCursor] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string>()
  const [selected, setSelected] = useState<AuditCenterRecord>()
  const [detail, setDetail] = useState<AuditCenterDetail>()
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string>()
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string>()

  const filtersRef = useRef(filters)
  const workspaceRef = useRef(workspaceId)
  const cursorRef = useRef(nextCursor)
  const listRequest = useRef(0)
  const detailRequest = useRef(0)
  const exportRequest = useRef(0)
  const listAbort = useRef<AbortController | undefined>(undefined)
  const detailAbort = useRef<AbortController | undefined>(undefined)
  const exportAbort = useRef<AbortController | undefined>(undefined)
  const detailReturnFocus = useRef<HTMLElement | undefined>(undefined)

  filtersRef.current = filters
  workspaceRef.current = workspaceId
  cursorRef.current = nextCursor

  const setFilters = useCallback((next: AuditCenterFilters) => {
    filtersRef.current = next
    cursorRef.current = undefined
    setNextCursor(undefined)
    setFiltersState(next)
  }, [])

  const run = useCallback(async (append = false) => {
    const cursor = append ? cursorRef.current : undefined
    if (append && !cursor) return

    const request = ++listRequest.current
    listAbort.current?.abort()
    const controller = new AbortController()
    listAbort.current = controller
    append ? setLoadingMore(true) : setLoading(true)
    setError(undefined)

    try {
      const page = platformScope && client.listPlatform
        ? await client.listPlatform(filtersRef.current, controller.signal)
        : await client.list(buildAuditCenterQuery(workspaceRef.current, filtersRef.current, cursor), controller.signal)
      if (request !== listRequest.current || controller.signal.aborted) return
      const pageRecords = Array.isArray(page?.records) ? page.records : []
      const pageCursor = typeof page?.nextCursor === 'string' && page.nextCursor
        ? page.nextCursor
        : undefined
      setRecords(current => append ? mergeAuditRecords(current, pageRecords) : pageRecords)
      setTotalRecords(typeof page?.totalRecords === 'number' ? page.totalRecords : pageRecords.length)
      setTruncated(page?.truncated === true || Boolean(pageCursor))
      cursorRef.current = pageCursor
      setNextCursor(pageCursor)
    } catch (cause) {
      if (!controller.signal.aborted && request === listRequest.current) {
        setError(message(cause, '审计记录加载失败，请重试。'))
      }
    } finally {
      if (request === listRequest.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [client, platformScope])

  const openDetail = useCallback(async (record: AuditCenterRecord, returnFocusTo?: HTMLElement | null) => {
    const request = ++detailRequest.current
    detailAbort.current?.abort()
    const controller = new AbortController()
    detailAbort.current = controller
    if (returnFocusTo) detailReturnFocus.current = returnFocusTo
    setSelected(record)
    setDetail(undefined)
    setDetailError(undefined)
    setDetailLoading(true)

    try {
      const loaded = await client.detail(
        { workspaceId: workspaceRef.current, source: record.source, id: record.id },
        controller.signal,
      )
      if (request === detailRequest.current && !controller.signal.aborted) setDetail(loaded)
    } catch (cause) {
      if (!controller.signal.aborted && request === detailRequest.current) {
        setDetailError(message(cause, '审计详情加载失败。'))
      }
    } finally {
      if (request === detailRequest.current) setDetailLoading(false)
    }
  }, [client])

  const closeDetail = useCallback(() => {
    detailRequest.current += 1
    detailAbort.current?.abort()
    setSelected(undefined)
    setDetail(undefined)
    setDetailError(undefined)
    setDetailLoading(false)
    const target = detailReturnFocus.current
    detailReturnFocus.current = undefined
    if (target?.isConnected) window.requestAnimationFrame(() => target.focus())
  }, [])

  const downloadCsv = useCallback(async () => {
    const request = ++exportRequest.current
    exportAbort.current?.abort()
    const controller = new AbortController()
    exportAbort.current = controller
    setExporting(true)
    setExportError(undefined)

    try {
      const result = await client.exportCsv(
        buildAuditCenterQuery(workspaceRef.current, filtersRef.current, undefined, 100),
        controller.signal,
      )
      if (request !== exportRequest.current || controller.signal.aborted) return
      const url = URL.createObjectURL(new Blob([result.csv], { type: result.contentType }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = result.fileName
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch (cause) {
      if (!controller.signal.aborted && request === exportRequest.current) {
        setExportError(message(cause, '审计导出失败，请重试。'))
      }
    } finally {
      if (request === exportRequest.current) setExporting(false)
    }
  }, [client])

  useEffect(() => {
    listRequest.current += 1
    detailRequest.current += 1
    exportRequest.current += 1
    listAbort.current?.abort()
    detailAbort.current?.abort()
    exportAbort.current?.abort()
    cursorRef.current = undefined
    setRecords([])
    setNextCursor(undefined)
    setSelected(undefined)
    setDetail(undefined)
    setError(undefined)
    setExportError(undefined)
    setLoading(false)
    setLoadingMore(false)
    setExporting(false)
  }, [workspaceId])

  useEffect(() => {
    if (!autoLoad) return
    // Cancel the prior workspace/filter request immediately; the replacement is debounced.
    listRequest.current += 1
    listAbort.current?.abort()
    setLoading(true)
    setLoadingMore(false)
    const timer = window.setTimeout(() => void run(false), 250)
    return () => window.clearTimeout(timer)
  }, [autoLoad, filters, workspaceId, client, platformScope, run])

  useEffect(() => () => {
    listRequest.current += 1
    detailRequest.current += 1
    exportRequest.current += 1
    listAbort.current?.abort()
    detailAbort.current?.abort()
    exportAbort.current?.abort()
  }, [])

  return {
    filters,
    setFilters,
    records,
    totalRecords,
    truncated,
    nextCursor,
    loading,
    loadingMore,
    error,
    empty: !loading && !error && records.length === 0,
    selected,
    detail,
    detailLoading,
    detailError,
    exporting,
    exportError,
    reload: () => run(false),
    loadMore: () => run(true),
    openDetail,
    closeDetail,
    downloadCsv,
  }
}
