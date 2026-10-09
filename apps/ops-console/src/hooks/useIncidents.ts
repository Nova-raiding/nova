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

export function useIncidents(client: IncidentsClient, initialFilters: IncidentFilters = {}, platformScope = false) {
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
  const [error, setError] = useState('')
  const listRequests = useRef(new IncidentRequestGate())
  const detailRequests = useRef(new IncidentRequestGate())
  const selectedIncidentId = useRef<string | undefined>(undefined)

  const load = useCallback(async (options: { append?: boolean; filters?: IncidentFilters } = {}) => {
    const request = listRequests.current.begin()
    const activeFilters = options.filters ?? filters
    setLoading(true)
    setError('')
    try {
      const page = await client.list({ ...activeFilters, limit: 20, ...(platformScope ? { platformScope: true } : {}), ...(options.append && nextCursor ? { cursor: nextCursor } : {}) })
      if (!listRequests.current.isCurrent(request)) return
      setIncidents((current) => options.append ? mergeIncidentPage(current, page.items) : page.items)
      setNextCursor(page.nextCursor)
      if (!options.append) setFilters(activeFilters)
    } catch (cause) {
      if (listRequests.current.isCurrent(request)) setError(errorMessage(cause))
    } finally {
      if (listRequests.current.isCurrent(request)) setLoading(false)
    }
  }, [client, filters, nextCursor, platformScope])

  useEffect(() => { void load() }, []) // Deliberately load once; filters are applied explicitly.
  useEffect(() => () => { listRequests.current.invalidate(); detailRequests.current.invalidate() }, [])

  const select = useCallback(async (incident: OpsIncident) => {
    const request = detailRequests.current.begin()
    selectedIncidentId.current = incident.id
    setSelected(incident)
    setDetailVerified(false)
    setTimeline([])
    setTimelineVerified(false)
    setTimelineNextCursor(undefined)
    setDetailError('')
    setTimelineError('')
    setError('')
    setDetailLoading(true)
    const [detailResult, timelineResult] = await Promise.allSettled([
      client.get(incident.id),
      client.timeline({ incidentId: incident.id, limit: 200 }),
    ])
    if (!detailRequests.current.isCurrent(request)) return
    if (detailResult.status === 'fulfilled') {
      setSelected(detailResult.value)
      setDetailVerified(true)
    } else {
      setDetailError(errorMessage(detailResult.reason))
    }
    if (timelineResult.status === 'fulfilled') {
      setTimeline(timelineResult.value.items)
      setTimelineNextCursor(timelineResult.value.nextCursor)
      setTimelineVerified(true)
    } else {
      setTimelineError(errorMessage(timelineResult.reason))
    }
    setDetailLoading(false)
  }, [client])

  const retryDetail = useCallback(() => {
    if (selected) void select(selected)
  }, [select, selected])

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

  const runMutation = useCallback(async (operation: () => Promise<IncidentMutationResult>, shouldSelectResult: (result: IncidentMutationResult) => boolean = () => true) => {
    setMutating(true)
    setError('')
    try {
      const result = await operation()
      return acceptMutation(result, shouldSelectResult(result))
    } catch (cause) {
      setError(errorMessage(cause))
      throw cause
    } finally {
      setMutating(false)
    }
  }, [acceptMutation])

  const create = useCallback((input: Parameters<IncidentsClient['create']>[0]) => runMutation(() => client.create(input)), [client, runMutation])
  const runDetailMutation = useCallback((operation: () => Promise<IncidentMutationResult>) => {
    if (!detailVerified || !selected) throw new Error('事故详情尚未验证，无法执行操作。')
    const requestedIncidentId = selected.id
    return runMutation(operation, (result) => selectedIncidentId.current === requestedIncidentId && result.incident.id === requestedIncidentId)
  }, [detailVerified, runMutation, selected])
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

  return { filters, incidents, nextCursor, selected, detailVerified, detailError, timelineVerified, timeline, timelineNextCursor, timelineError, loading, detailLoading, mutating, error, setFilters, load, select, retryDetail, retryTimeline, loadMoreTimeline, close, create, comment, transition, assignCommander, updateScope }
}
