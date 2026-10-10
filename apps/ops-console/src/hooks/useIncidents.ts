import { useCallback, useEffect, useRef, useState } from 'react'

export type IncidentSeverity = 'sev1' | 'sev2' | 'sev3' | 'sev4'
export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved'

export interface OpsIncident {
  id: string; workspaceId: string; title: string; summary: string; severity: IncidentSeverity; status: IncidentStatus;
  commanderId?: string; affectedComponents: string[]; affectedWorkspaceIds: string[]; revision: number;
  createdBy: string; createdAt: string; updatedAt: string; resolvedAt?: string; aggregate?: boolean; count?: number
}

export interface IncidentTimelineEntry {
  id: string; workspaceId: string; incidentId: string; kind: 'created' | 'comment' | 'status_changed' | 'commander_changed' | 'scope_changed';
  body: string; fromStatus?: IncidentStatus; toStatus?: IncidentStatus; actorId: string; incidentRevision: number; createdAt: string
}

export interface IncidentPage<T> { items: T[]; nextCursor?: string }
export interface IncidentMutationResult { incident: OpsIncident; event: IncidentTimelineEntry }
export interface IncidentFilters { status?: IncidentStatus; severity?: IncidentSeverity }
export type IncidentErrorContext = 'list-read' | 'append-read' | 'create-mutation' | 'detail-mutation'

export interface IncidentsClient {
  list(input: IncidentFilters & { limit: number; cursor?: string; platformScope?: boolean }): Promise<IncidentPage<OpsIncident>>
  get(incidentId: string): Promise<OpsIncident>
  timeline(input: { incidentId: string; limit: number; cursor?: string }): Promise<IncidentPage<IncidentTimelineEntry>>
  create(input: { title: string; summary: string; severity: IncidentSeverity; commanderId?: string; affectedComponents: string[]; affectedWorkspaceIds: string[]; idempotencyKey: string }): Promise<IncidentMutationResult>
  comment(input: { incidentId: string; expectedRevision: number; body: string; idempotencyKey: string }): Promise<IncidentMutationResult>
  transition(input: { incidentId: string; expectedRevision: number; toStatus: IncidentStatus; note: string; idempotencyKey: string }): Promise<IncidentMutationResult>
  assignCommander(input: { incidentId: string; expectedRevision: number; commanderId?: string; note: string; idempotencyKey: string }): Promise<IncidentMutationResult>
  updateScope(input: { incidentId: string; expectedRevision: number; affectedComponents: string[]; affectedWorkspaceIds: string[]; note: string; idempotencyKey: string }): Promise<IncidentMutationResult>
}

export const incidentNextStatus: Record<IncidentStatus, IncidentStatus | undefined> = {
  investigating: 'identified', identified: 'monitoring', monitoring: 'resolved', resolved: undefined,
}

export class IncidentRequestGate {
  private sequence = 0
  begin() { return ++this.sequence }
  isCurrent(request: number) { return request === this.sequence }
  invalidate() { this.sequence += 1 }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '事故数据请求失败，请重试。'
}

export function mergeIncidentPage(current: readonly OpsIncident[], incoming: readonly OpsIncident[]): OpsIncident[] {
  const byId = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) byId.set(item.id, item)
  return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
}

export function mergeTimelinePage(current: readonly IncidentTimelineEntry[], incoming: readonly IncidentTimelineEntry[]): IncidentTimelineEntry[] {
  const byId = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) byId.set(item.id, item)
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

export function incidentErrorTargetsSelection(errorIncidentId: string | undefined, selectedIncidentId: string | undefined): boolean {
  return Boolean(errorIncidentId && selectedIncidentId === errorIncidentId)
}

type UncertainIncidentWrite = { kind: 'create' } | { kind: 'detail'; incidentId: string; incident?: OpsIncident } | { kind: 'unknown' }

export function useIncidents(client: IncidentsClient, initialFilters: IncidentFilters = {}, platformScope = false, recoveryScopeKey = platformScope ? 'platform' : 'workspace:unknown') {
  const recoveryStorageKey = `ops:incidents:uncertain-write:${recoveryScopeKey}`
  const [persistedUncertainWrite, setPersistedUncertainWrite] = useState<UncertainIncidentWrite | undefined>(() => {
    try {
      const raw = window.sessionStorage.getItem(recoveryStorageKey)
      if (!raw) return undefined
      const parsed = JSON.parse(raw) as UncertainIncidentWrite
      return parsed && (parsed.kind === 'create' || parsed.kind === 'unknown' || (parsed.kind === 'detail' && typeof parsed.incidentId === 'string')) ? parsed : { kind: 'unknown' }
    } catch { return { kind: 'unknown' } }
  })
  const [filters, setFilters] = useState<IncidentFilters>(initialFilters)
  const [incidents, setIncidents] = useState<OpsIncident[]>([])
  const [nextCursor, setNextCursor] = useState<string>()
  const [selected, setSelected] = useState<OpsIncident>()
  const [timeline, setTimeline] = useState<IncidentTimelineEntry[]>([])
  const [timelineNextCursor, setTimelineNextCursor] = useState<string>()
  const [detailVerified, setDetailVerified] = useState(false)
  const [timelineVerified, setTimelineVerified] = useState(false)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [timelineError, setTimelineError] = useState('')
  const [mutating, setMutating] = useState(false)
  const [error, setError] = useState(() => persistedUncertainWrite ? '检测到上次会话有未核对的事故写操作。' : '')
  const [errorContext, setErrorContext] = useState<IncidentErrorContext | undefined>(() => persistedUncertainWrite?.kind === 'detail' ? 'detail-mutation' : persistedUncertainWrite ? 'create-mutation' : undefined)
  const [errorIncidentId, setErrorIncidentId] = useState<string | undefined>(() => persistedUncertainWrite?.kind === 'detail' ? persistedUncertainWrite.incidentId : undefined)
  const [mutationUncertain, setMutationUncertain] = useState(false)
  const [uncertainMutationTarget, setUncertainMutationTarget] = useState<OpsIncident | undefined>(() => persistedUncertainWrite?.kind === 'detail' ? persistedUncertainWrite.incident : undefined)
  const [uncertainMutationIncidentId, setUncertainMutationIncidentId] = useState<string | undefined>(() => persistedUncertainWrite?.kind === 'detail' ? persistedUncertainWrite.incidentId : undefined)
  const [createReconciled, setCreateReconciled] = useState(false)
  const [recoveryWriteBlocked, setRecoveryWriteBlocked] = useState(false)
  const listRequests = useRef(new IncidentRequestGate())
  const detailRequests = useRef(new IncidentRequestGate())
  const selectedIncidentId = useRef<string | undefined>(undefined)

  const load = useCallback(async (options: { append?: boolean; filters?: IncidentFilters } = {}) => {
    const request = listRequests.current.begin()
    const activeFilters = options.filters ?? filters
    setLoading(true)
    if (!persistedUncertainWrite) {
      setError('')
      setErrorContext(undefined)
      setErrorIncidentId(undefined)
    }
    try {
      const page = await client.list({ ...activeFilters, limit: 20, ...(platformScope ? { platformScope: true } : {}), ...(options.append && nextCursor ? { cursor: nextCursor } : {}) })
      if (!listRequests.current.isCurrent(request)) return
      setIncidents((current) => options.append ? mergeIncidentPage(current, page.items) : page.items)
      setNextCursor(page.nextCursor)
      if (!options.append) setFilters(activeFilters)
      if (!options.append && persistedUncertainWrite?.kind === 'create') {
        setCreateReconciled(true)
        if (errorContext === 'list-read') {
          setError('上一次事故创建结果仍待核对。')
          setErrorContext('create-mutation')
        }
      }
    } catch (cause) {
      if (listRequests.current.isCurrent(request)) {
        setError(errorMessage(cause))
        if (uncertainMutationIncidentId) {
          setErrorContext('detail-mutation')
          setErrorIncidentId(uncertainMutationIncidentId)
        } else if (persistedUncertainWrite?.kind === 'create') {
          setErrorContext(options.append ? 'append-read' : 'list-read')
        } else {
          setErrorContext(options.append ? 'append-read' : 'list-read')
        }
      }
    } finally {
      if (listRequests.current.isCurrent(request)) setLoading(false)
    }
  }, [client, errorContext, filters, nextCursor, platformScope, persistedUncertainWrite, uncertainMutationIncidentId])

  useEffect(() => { void load() }, []) // Deliberately load once; filters are applied explicitly.
  useEffect(() => () => { listRequests.current.invalidate(); detailRequests.current.invalidate() }, [])

  const select = useCallback(async (incident: OpsIncident) => {
    const reconcilingUncertainMutation = uncertainMutationIncidentId === incident.id
    const request = detailRequests.current.begin()
    selectedIncidentId.current = incident.id
    setSelected(incident)
    setDetailVerified(false)
    setTimeline([])
    setTimelineVerified(false)
    setTimelineNextCursor(undefined)
    setDetailError('')
    setTimelineError('')
    if (!reconcilingUncertainMutation && !uncertainMutationIncidentId && persistedUncertainWrite?.kind !== 'create') {
      setError('')
      setErrorContext(undefined)
      setErrorIncidentId(undefined)
    } else if (persistedUncertainWrite?.kind === 'create') {
      setError('上一次事故创建结果尚未确认。请重新读取事故列表并明确确认后再继续。')
      setErrorContext('create-mutation')
    } else if (reconcilingUncertainMutation) {
      setError('上一次事故写操作结果尚未确认。请重新核对事故详情和时间线；系统不会自动重放。')
      setErrorContext('detail-mutation')
      setErrorIncidentId(incident.id)
    }
    setDetailLoading(true)
    const [detailResult, timelineResult] = await Promise.allSettled([
      client.get(incident.id),
      client.timeline({ incidentId: incident.id, limit: 200 }),
    ])
    if (!detailRequests.current.isCurrent(request)) return
    if (detailResult.status === 'fulfilled') {
      if (detailResult.value.id === incident.id) {
        setSelected(detailResult.value)
        const timelineMatchesTarget = timelineResult.status === 'fulfilled' && timelineResult.value.items.every((entry) => entry.incidentId === incident.id)
        setDetailVerified(timelineResult.status === 'fulfilled' ? timelineMatchesTarget : !reconcilingUncertainMutation)
      } else {
        setDetailError('详情接口返回了不匹配的事故记录，无法验证当前事故。')
      }
    } else {
      setDetailError(errorMessage(detailResult.reason))
    }
    if (timelineResult.status === 'fulfilled') {
      const timelineMatchesTarget = timelineResult.value.items.every((entry) => entry.incidentId === incident.id)
      setTimeline(timelineMatchesTarget ? timelineResult.value.items : [])
      setTimelineNextCursor(timelineResult.value.nextCursor)
      setTimelineVerified(timelineMatchesTarget)
      if (!timelineMatchesTarget) setTimelineError('时间线返回了不匹配的事故记录，无法完成核对。')
    } else {
      setTimelineError(errorMessage(timelineResult.reason))
    }
    const detailMatchesTarget = detailResult.status === 'fulfilled' && detailResult.value.id === incident.id
    const timelineMatchesTarget = timelineResult.status === 'fulfilled' && timelineResult.value.items.every((entry) => entry.incidentId === incident.id)
    if (reconcilingUncertainMutation && detailMatchesTarget && timelineMatchesTarget) {
      setPersistedUncertainWrite(undefined)
      try { window.sessionStorage.removeItem(recoveryStorageKey) } catch { /* Keep the current-page state authoritative. */ }
      setUncertainMutationIncidentId(undefined)
      setMutationUncertain(false)
      setUncertainMutationTarget(undefined)
      setError('')
      setErrorContext(undefined)
      setErrorIncidentId(undefined)
    }
    setDetailLoading(false)
  }, [client, persistedUncertainWrite, recoveryStorageKey, uncertainMutationIncidentId])

  const retryDetail = useCallback(() => {
    const target = selected ?? incidents.find((incident) => incident.id === uncertainMutationIncidentId) ?? uncertainMutationTarget
    if (target) void select(target)
  }, [incidents, select, selected, uncertainMutationIncidentId, uncertainMutationTarget])

  const acknowledgeCreateReconciliation = useCallback(() => {
    if (persistedUncertainWrite?.kind !== 'create' || !createReconciled) return
    try { window.sessionStorage.removeItem(recoveryStorageKey) } catch { return }
    setPersistedUncertainWrite(undefined)
    setCreateReconciled(false)
    setMutationUncertain(false)
    setUncertainMutationTarget(undefined)
    setError(''); setErrorContext(undefined); setErrorIncidentId(undefined)
  }, [createReconciled, persistedUncertainWrite, recoveryStorageKey])

  const retryTimeline = useCallback(async () => {
    if (!selected) return
    const request = detailRequests.current.begin()
    setDetailLoading(true)
    setTimelineError('')
    try {
      const page = await client.timeline({ incidentId: selected.id, limit: 200 })
      if (!detailRequests.current.isCurrent(request)) return
      setTimeline(page.items)
      setTimelineNextCursor(page.nextCursor)
      setTimelineVerified(true)
    } catch (cause) {
      if (detailRequests.current.isCurrent(request)) setTimelineError(errorMessage(cause))
    } finally {
      if (detailRequests.current.isCurrent(request)) setDetailLoading(false)
    }
  }, [client, selected])

  const loadMoreTimeline = useCallback(async () => {
    if (!selected || !timelineNextCursor) return
    const request = detailRequests.current.begin()
    setDetailLoading(true)
    setTimelineError('')
    try {
      const page = await client.timeline({ incidentId: selected.id, limit: 200, cursor: timelineNextCursor })
      if (!detailRequests.current.isCurrent(request)) return
      setTimeline((current) => mergeTimelinePage(current, page.items))
      setTimelineNextCursor(page.nextCursor)
      setTimelineVerified(true)
    } catch (cause) {
      if (detailRequests.current.isCurrent(request)) setTimelineError(errorMessage(cause))
    } finally {
      if (detailRequests.current.isCurrent(request)) setDetailLoading(false)
    }
  }, [client, selected, timelineNextCursor])

  const acceptMutation = useCallback((result: IncidentMutationResult, selectResult = true) => {
    setIncidents((current) => mergeIncidentPage(current, [result.incident]))
    if (selectResult) {
      selectedIncidentId.current = result.incident.id
      setSelected(result.incident)
      setDetailVerified(true)
      setTimeline((current) => mergeTimelinePage(current, [result.event]))
      setTimelineVerified(true)
    }
    return result
  }, [])

  const runMutation = useCallback(async (operation: () => Promise<IncidentMutationResult>, context: Exclude<IncidentErrorContext, 'list-read' | 'append-read'>, shouldSelectResult: (result: IncidentMutationResult) => boolean = () => true, incidentId?: string, incidentSnapshot?: OpsIncident) => {
    if (context === 'create-mutation' && persistedUncertainWrite) {
      throw new Error('存在尚未核对的事故操作；请先核对失败目标后再创建事故。')
    }
    setMutating(true)
    setError('')
    setErrorContext(undefined)
    setErrorIncidentId(undefined)
    setRecoveryWriteBlocked(false)
    let operationDispatched = false
    try {
      if (context === 'create-mutation') {
        const record: UncertainIncidentWrite = { kind: 'create' }
        try { window.sessionStorage.setItem(recoveryStorageKey, JSON.stringify(record)) } catch { throw new Error('无法保存事故恢复记录，本次创建请求尚未发送。请检查浏览器存储后重试。') }
        setPersistedUncertainWrite(record); setMutationUncertain(true); setCreateReconciled(false)
      } else if (context === 'detail-mutation' && incidentId) {
        const record: UncertainIncidentWrite = { kind: 'detail', incidentId, ...(incidentSnapshot ? { incident: incidentSnapshot } : {}) }
        try { window.sessionStorage.setItem(recoveryStorageKey, JSON.stringify({ kind: 'detail', incidentId })) } catch { throw new Error('无法保存事故恢复记录，本次详情操作尚未发送。请检查浏览器存储后重试。') }
        setPersistedUncertainWrite(record); setUncertainMutationIncidentId(incidentId); setMutationUncertain(true); setUncertainMutationTarget(incidentSnapshot)
        setDetailVerified(false)
      }
      operationDispatched = true
      const result = await operation()
      if ((context === 'detail-mutation' && (result.incident.id !== incidentId || result.event.incidentId !== incidentId))
        || (context === 'create-mutation' && result.event.incidentId !== result.incident.id)) {
        throw new Error('事故写接口返回的目标标识不匹配，操作结果仍待核对。')
      }
      const accepted = acceptMutation(result, shouldSelectResult(result))
      if (context === 'create-mutation' || (context === 'detail-mutation' && incidentId)) {
        setPersistedUncertainWrite(undefined); setUncertainMutationIncidentId(undefined); setMutationUncertain(false); setUncertainMutationTarget(undefined)
        try { window.sessionStorage.removeItem(recoveryStorageKey) } catch { /* API success is authoritative for this page. */ }
      }
      return accepted
    } catch (cause) {
      setError(errorMessage(cause))
      setErrorContext(context)
      setErrorIncidentId(context === 'detail-mutation' ? incidentId : undefined)
      if (!operationDispatched) {
        setRecoveryWriteBlocked(true)
        setPersistedUncertainWrite(undefined); setUncertainMutationIncidentId(undefined); setMutationUncertain(false); setUncertainMutationTarget(undefined)
      } else if (context === 'detail-mutation' && incidentId) {
        const record: UncertainIncidentWrite = { kind: 'detail', incidentId, ...(incidentSnapshot ? { incident: incidentSnapshot } : {}) }
        setPersistedUncertainWrite(record)
        setUncertainMutationIncidentId(incidentId)
        setMutationUncertain(true)
        setUncertainMutationTarget(incidentSnapshot)
        setDetailVerified(false)
      } else if (context === 'create-mutation') {
        const record: UncertainIncidentWrite = { kind: 'create' }
        setPersistedUncertainWrite(record)
        setCreateReconciled(false)
        setMutationUncertain(true)
      }
      throw cause
    } finally {
      setMutating(false)
    }
  }, [acceptMutation, persistedUncertainWrite, recoveryStorageKey])

  const create = useCallback((input: Parameters<IncidentsClient['create']>[0]) => runMutation(() => client.create(input), 'create-mutation'), [client, runMutation])
  const runDetailMutation = useCallback((operation: () => Promise<IncidentMutationResult>) => {
    if (!detailVerified || !selected || persistedUncertainWrite) throw new Error('事故详情尚未验证或存在待核对操作，无法执行操作。')
    const requestedIncidentId = selected.id
    return runMutation(operation, 'detail-mutation', (result) => selectedIncidentId.current === requestedIncidentId && result.incident.id === requestedIncidentId, requestedIncidentId, selected)
  }, [detailVerified, runMutation, selected, persistedUncertainWrite])
  const comment = useCallback((input: Parameters<IncidentsClient['comment']>[0]) => runDetailMutation(() => client.comment(input)), [client, runDetailMutation])
  const transition = useCallback((input: Parameters<IncidentsClient['transition']>[0]) => runDetailMutation(() => client.transition(input)), [client, runDetailMutation])
  const assignCommander = useCallback((input: Parameters<IncidentsClient['assignCommander']>[0]) => runDetailMutation(() => client.assignCommander(input)), [client, runDetailMutation])
  const updateScope = useCallback((input: Parameters<IncidentsClient['updateScope']>[0]) => runDetailMutation(() => client.updateScope(input)), [client, runDetailMutation])

  const close = useCallback(() => {
    detailRequests.current.invalidate()
    selectedIncidentId.current = undefined
    setSelected(undefined)
    setDetailVerified(false)
    setTimeline([])
    setTimelineVerified(false)
    setTimelineNextCursor(undefined)
    setDetailError('')
    setTimelineError('')
    setDetailLoading(false)
  }, [])

  return { filters, incidents, nextCursor, selected, detailVerified, detailError, timelineVerified, mutationUncertain: mutationUncertain || Boolean(persistedUncertainWrite), uncertainMutationTarget, uncertainMutationKind: persistedUncertainWrite?.kind, createReconciled, acknowledgeCreateReconciliation, recoveryWriteBlocked, timeline, timelineNextCursor, timelineError, loading, detailLoading, mutating, error, errorContext, errorIncidentId, setFilters, load, select, retryDetail, retryTimeline, loadMoreTimeline, close, create, comment, transition, assignCommander, updateScope }
}
