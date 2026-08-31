import { randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlClient, type SqlPool, withWorkspaceTransaction } from './repository.js'

export type IncidentSeverity = 'sev1' | 'sev2' | 'sev3' | 'sev4'
export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved'
export type IncidentTimelineKind = 'created' | 'comment' | 'status_changed' | 'commander_changed' | 'scope_changed'

export interface Incident {
  id: string
  workspaceId: string
  title: string
  summary: string
  severity: IncidentSeverity
  status: IncidentStatus
  commanderId?: string
  affectedComponents: string[]
  affectedWorkspaceIds: string[]
  revision: number
  createdBy: string
  createdAt: string
  updatedAt: string
  resolvedAt?: string
}

export interface IncidentTimelineEntry {
  id: string
  workspaceId: string
  incidentId: string
  kind: IncidentTimelineKind
  body: string
  fromStatus?: IncidentStatus
  toStatus?: IncidentStatus
  actorId: string
  incidentRevision: number
  createdAt: string
}

export interface IncidentMutationResult {
  incident: Incident
  event: IncidentTimelineEntry
}

export interface IncidentPage<T> {
  items: T[]
  nextCursor?: string
}

export interface CreateIncidentRecord {
  workspaceId: string
  actorId: string
  title: string
  summary: string
  severity: IncidentSeverity
  commanderId?: string
  affectedComponents: string[]
  affectedWorkspaceIds: string[]
  idempotencyKey: string
  requestHash: string
}

export interface MutateIncidentRecord {
  workspaceId: string
  incidentId: string
  actorId: string
  expectedRevision: number
  operation: 'comment' | 'transition' | 'assign_commander' | 'update_scope'
  idempotencyKey: string
  requestHash: string
  event: {
    kind: Exclude<IncidentTimelineKind, 'created'>
    body: string
    fromStatus?: IncidentStatus
    toStatus?: IncidentStatus
  }
  patch?: {
    status?: IncidentStatus
    commanderId?: string | null
    affectedComponents?: string[]
    affectedWorkspaceIds?: string[]
  }
}

export interface IncidentRepository {
  create(input: CreateIncidentRecord): Promise<IncidentMutationResult>
  get(workspaceId: string, incidentId: string): Promise<Incident | undefined>
  list(input: { workspaceId: string; status?: IncidentStatus; severity?: IncidentSeverity; limit: number; cursor?: string }): Promise<IncidentPage<Incident>>
  mutate(input: MutateIncidentRecord): Promise<IncidentMutationResult>
  listTimeline(input: { workspaceId: string; incidentId: string; limit: number; cursor?: string }): Promise<IncidentPage<IncidentTimelineEntry>>
}

export class IncidentRepositoryError extends Error {
  constructor(readonly code: 'INCIDENT_NOT_FOUND' | 'INCIDENT_REVISION_CONFLICT' | 'INCIDENT_IDEMPOTENCY_CONFLICT' | 'INCIDENT_INVALID_CURSOR' | 'INCIDENT_INVALID_LIMIT' | 'INCIDENT_INVALID_TRANSITION', message: string) {
    super(message)
    this.name = 'IncidentRepositoryError'
  }
}

type Cursor = { at: string; id: string }
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function encodeCursor(value: Cursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeCursor(value: string | undefined): Cursor | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<Cursor>
    if (typeof parsed.at !== 'string' || !Number.isFinite(Date.parse(parsed.at)) || typeof parsed.id !== 'string' || !uuidPattern.test(parsed.id)) throw new Error('invalid')
    return { at: new Date(parsed.at).toISOString(), id: parsed.id }
  } catch {
    throw new IncidentRepositoryError('INCIDENT_INVALID_CURSOR', 'incident cursor is invalid')
  }
}

function boundedLimit(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new IncidentRepositoryError('INCIDENT_INVALID_LIMIT', `incident page limit must be between 1 and ${max}`)
  }
  return value
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function cloneIncident(value: Incident): Incident {
  return { ...value, affectedComponents: [...value.affectedComponents], affectedWorkspaceIds: [...value.affectedWorkspaceIds] }
}

function cloneResult(value: IncidentMutationResult): IncidentMutationResult {
  return { incident: cloneIncident(value.incident), event: { ...value.event } }
}

function idempotencyIdentity(input: { workspaceId: string; idempotencyKey: string }): string {
  return `${input.workspaceId}\u0000${input.idempotencyKey}`
}

export class MemoryIncidentRepository implements IncidentRepository {
  private readonly incidents = new Map<string, Incident>()
  private readonly timeline: IncidentTimelineEntry[] = []
  private readonly replays = new Map<string, { actorId: string; operation: string; requestHash: string; result: IncidentMutationResult }>()
  private now = 0

  private timestamp(): string {
    this.now += 1
    return new Date(Date.now() + this.now).toISOString()
  }

  private replay(input: { workspaceId: string; idempotencyKey: string; actorId: string; operation: string; requestHash: string }): IncidentMutationResult | undefined {
    const prior = this.replays.get(idempotencyIdentity(input))
    if (!prior) return undefined
    if (prior.actorId !== input.actorId || prior.operation !== input.operation || prior.requestHash !== input.requestHash) {
      throw new IncidentRepositoryError('INCIDENT_IDEMPOTENCY_CONFLICT', 'idempotency key was already used for another incident mutation')
    }
    return cloneResult(prior.result)
  }

  private remember(input: { workspaceId: string; idempotencyKey: string; actorId: string; operation: string; requestHash: string }, result: IncidentMutationResult): IncidentMutationResult {
    this.replays.set(idempotencyIdentity(input), { actorId: input.actorId, operation: input.operation, requestHash: input.requestHash, result: cloneResult(result) })
    return cloneResult(result)
  }

  async create(input: CreateIncidentRecord): Promise<IncidentMutationResult> {
    requireWorkspaceScope(input.workspaceId)
    const replay = this.replay({ ...input, operation: 'create' })
    if (replay) return replay
    const createdAt = this.timestamp()
    const incident: Incident = {
      id: randomUUID(), workspaceId: input.workspaceId, title: input.title, summary: input.summary,
      severity: input.severity, status: 'investigating', ...(input.commanderId ? { commanderId: input.commanderId } : {}),
      affectedComponents: [...input.affectedComponents], affectedWorkspaceIds: [...input.affectedWorkspaceIds],
      revision: 1, createdBy: input.actorId, createdAt, updatedAt: createdAt,
    }
    const event: IncidentTimelineEntry = { id: randomUUID(), workspaceId: input.workspaceId, incidentId: incident.id, kind: 'created', body: input.summary, actorId: input.actorId, incidentRevision: 1, createdAt }
    this.incidents.set(`${input.workspaceId}:${incident.id}`, incident)
    this.timeline.push(event)
    return this.remember({ ...input, operation: 'create' }, { incident, event })
  }

  async get(workspaceId: string, incidentId: string): Promise<Incident | undefined> {
    requireWorkspaceScope(workspaceId)
    const row = this.incidents.get(`${workspaceId}:${incidentId}`)
    return row ? cloneIncident(row) : undefined
  }

  async list(input: { workspaceId: string; status?: IncidentStatus; severity?: IncidentSeverity; limit: number; cursor?: string }): Promise<IncidentPage<Incident>> {
    requireWorkspaceScope(input.workspaceId)
    const limit = boundedLimit(input.limit, 100)
    const cursor = decodeCursor(input.cursor)
    const rows = [...this.incidents.values()]
      .filter((row) => row.workspaceId === input.workspaceId && (!input.status || row.status === input.status) && (!input.severity || row.severity === input.severity))
      .filter((row) => !cursor || row.updatedAt < cursor.at || (row.updatedAt === cursor.at && row.id < cursor.id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
      .slice(0, limit + 1)
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map(cloneIncident)
    const last = items.at(-1)
    return { items, ...(hasMore && last ? { nextCursor: encodeCursor({ at: last.updatedAt, id: last.id }) } : {}) }
  }

  async mutate(input: MutateIncidentRecord): Promise<IncidentMutationResult> {
    requireWorkspaceScope(input.workspaceId)
    const replay = this.replay(input)
    if (replay) return replay
    const key = `${input.workspaceId}:${input.incidentId}`
    const current = this.incidents.get(key)
    if (!current) throw new IncidentRepositoryError('INCIDENT_NOT_FOUND', 'incident was not found')
    if (current.revision !== input.expectedRevision) throw new IncidentRepositoryError('INCIDENT_REVISION_CONFLICT', 'incident revision is stale')
    if (input.operation === 'transition' && (current.status !== input.event.fromStatus || input.patch?.status !== input.event.toStatus)) throw new IncidentRepositoryError('INCIDENT_INVALID_TRANSITION', 'incident transition does not match current status')
    const createdAt = this.timestamp()
    const revision = current.revision + 1
    const status = input.patch?.status ?? current.status
    const incident: Incident = {
      ...current,
      status,
      ...(input.patch && 'commanderId' in input.patch
        ? (input.patch.commanderId ? { commanderId: input.patch.commanderId } : { commanderId: undefined })
        : {}),
      ...(input.patch?.affectedComponents ? { affectedComponents: [...input.patch.affectedComponents] } : {}),
      ...(input.patch?.affectedWorkspaceIds ? { affectedWorkspaceIds: [...input.patch.affectedWorkspaceIds] } : {}),
      revision,
      updatedAt: createdAt,
      ...(status === 'resolved' ? { resolvedAt: createdAt } : { resolvedAt: undefined }),
    }
    const event: IncidentTimelineEntry = {
      id: randomUUID(), workspaceId: input.workspaceId, incidentId: input.incidentId, kind: input.event.kind,
      body: input.event.body, ...(input.event.fromStatus ? { fromStatus: input.event.fromStatus } : {}),
      ...(input.event.toStatus ? { toStatus: input.event.toStatus } : {}), actorId: input.actorId, incidentRevision: revision, createdAt,
    }
    this.incidents.set(key, incident)
    this.timeline.push(event)
    return this.remember(input, { incident, event })
  }

  async listTimeline(input: { workspaceId: string; incidentId: string; limit: number; cursor?: string }): Promise<IncidentPage<IncidentTimelineEntry>> {
    requireWorkspaceScope(input.workspaceId)
    const limit = boundedLimit(input.limit, 200)
    if (!this.incidents.has(`${input.workspaceId}:${input.incidentId}`)) throw new IncidentRepositoryError('INCIDENT_NOT_FOUND', 'incident was not found')
    const cursor = decodeCursor(input.cursor)
    const rows = this.timeline
      .filter((row) => row.workspaceId === input.workspaceId && row.incidentId === input.incidentId)
      .filter((row) => !cursor || row.createdAt > cursor.at || (row.createdAt === cursor.at && row.id > cursor.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .slice(0, limit + 1)
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map((row) => ({ ...row }))
    const last = items.at(-1)
    return { items, ...(hasMore && last ? { nextCursor: encodeCursor({ at: last.createdAt, id: last.id }) } : {}) }
  }
}

type IncidentRow = {
  id: string; workspace_id: string; title: string; summary: string; severity: IncidentSeverity; status: IncidentStatus;
  commander_id: string | null; affected_components: string[]; affected_workspace_ids: string[]; revision: number;
  created_by: string; created_at: string | Date; updated_at: string | Date; resolved_at: string | Date | null
}
type TimelineRow = {
  id: string; workspace_id: string; incident_id: string; kind: IncidentTimelineKind; body: string;
  from_status: IncidentStatus | null; to_status: IncidentStatus | null; actor_id: string; incident_revision: number; created_at: string | Date
}

function mapIncident(row: IncidentRow): Incident {
  return {
    id: row.id, workspaceId: row.workspace_id, title: row.title, summary: row.summary, severity: row.severity, status: row.status,
    ...(row.commander_id ? { commanderId: row.commander_id } : {}), affectedComponents: row.affected_components,
    affectedWorkspaceIds: row.affected_workspace_ids, revision: row.revision, createdBy: row.created_by,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), ...(row.resolved_at ? { resolvedAt: iso(row.resolved_at) } : {}),
  }
}

function mapTimeline(row: TimelineRow): IncidentTimelineEntry {
  return {
    id: row.id, workspaceId: row.workspace_id, incidentId: row.incident_id, kind: row.kind, body: row.body,
    ...(row.from_status ? { fromStatus: row.from_status } : {}), ...(row.to_status ? { toStatus: row.to_status } : {}),
    actorId: row.actor_id, incidentRevision: row.incident_revision, createdAt: iso(row.created_at),
  }
}

const incidentColumns = 'id, workspace_id, title, summary, severity, status, commander_id, affected_components, affected_workspace_ids, revision, created_by, created_at, updated_at, resolved_at'
const timelineColumns = 'id, workspace_id, incident_id, kind, body, from_status, to_status, actor_id, incident_revision, created_at'

export class PostgresIncidentRepository implements IncidentRepository {
  constructor(private readonly pool: SqlPool) {}

  private async lockIdempotency(client: SqlClient, input: { workspaceId: string; idempotencyKey: string }): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${input.workspaceId}:${input.idempotencyKey}`])
  }

  private async replay(client: SqlClient, input: { workspaceId: string; idempotencyKey: string; actorId: string; operation: string; requestHash: string }): Promise<IncidentMutationResult | undefined> {
    const result = await client.query<{ actor_id: string; operation: string; request_hash: string; result_json: IncidentMutationResult }>('SELECT actor_id, operation, request_hash, result_json FROM ops_incident_idempotency WHERE workspace_id=$1 AND idempotency_key=$2', [input.workspaceId, input.idempotencyKey])
    const row = result.rows[0]
    if (!row) return undefined
    if (row.actor_id !== input.actorId || row.operation !== input.operation || row.request_hash !== input.requestHash) throw new IncidentRepositoryError('INCIDENT_IDEMPOTENCY_CONFLICT', 'idempotency key was already used for another incident mutation')
    return row.result_json
  }

  private async remember(client: SqlClient, input: { workspaceId: string; idempotencyKey: string; actorId: string; operation: string; requestHash: string }, result: IncidentMutationResult): Promise<void> {
    await client.query('INSERT INTO ops_incident_idempotency (workspace_id, idempotency_key, actor_id, operation, request_hash, result_json) VALUES ($1,$2,$3,$4,$5,$6)', [input.workspaceId, input.idempotencyKey, input.actorId, input.operation, input.requestHash, result])
  }

  async create(input: CreateIncidentRecord): Promise<IncidentMutationResult> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, workspaceId, async (client) => {
      const identity = { ...input, operation: 'create' }
      await this.lockIdempotency(client, input)
      const replay = await this.replay(client, identity)
      if (replay) return replay
      const incidentId = randomUUID()
      const incidentResult = await client.query<IncidentRow>(`INSERT INTO ops_incidents (id, workspace_id, title, summary, severity, commander_id, affected_components, affected_workspace_ids, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${incidentColumns}`, [incidentId, workspaceId, input.title, input.summary, input.severity, input.commanderId ?? null, input.affectedComponents, input.affectedWorkspaceIds, input.actorId])
      const timelineResult = await client.query<TimelineRow>(`INSERT INTO ops_incident_timeline (id, workspace_id, incident_id, kind, body, actor_id, incident_revision) VALUES ($1,$2,$3,'created',$4,$5,1) RETURNING ${timelineColumns}`, [randomUUID(), workspaceId, incidentId, input.summary, input.actorId])
      const result = { incident: mapIncident(incidentResult.rows[0]!), event: mapTimeline(timelineResult.rows[0]!) }
      await this.remember(client, identity, result)
      return result
    })
  }

  async get(workspaceId: string, incidentId: string): Promise<Incident | undefined> {
    requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, workspaceId, async (client) => {
      const result = await client.query<IncidentRow>(`SELECT ${incidentColumns} FROM ops_incidents WHERE workspace_id=$1 AND id=$2`, [workspaceId, incidentId])
      return result.rows[0] ? mapIncident(result.rows[0]) : undefined
    })
  }

  async list(input: { workspaceId: string; status?: IncidentStatus; severity?: IncidentSeverity; limit: number; cursor?: string }): Promise<IncidentPage<Incident>> {
    requireWorkspaceScope(input.workspaceId)
    const limit = boundedLimit(input.limit, 100)
    const cursor = decodeCursor(input.cursor)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async (client) => {
      const result = await client.query<IncidentRow>(`SELECT ${incidentColumns} FROM ops_incidents WHERE workspace_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR severity=$3) AND ($4::timestamptz IS NULL OR (updated_at, id) < ($4::timestamptz, $5::uuid)) ORDER BY updated_at DESC, id DESC LIMIT $6`, [input.workspaceId, input.status ?? null, input.severity ?? null, cursor?.at ?? null, cursor?.id ?? null, limit + 1])
      const hasMore = result.rows.length > limit
      const items = result.rows.slice(0, limit).map(mapIncident)
      const last = items.at(-1)
      return { items, ...(hasMore && last ? { nextCursor: encodeCursor({ at: last.updatedAt, id: last.id }) } : {}) }
    })
  }

  async mutate(input: MutateIncidentRecord): Promise<IncidentMutationResult> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, workspaceId, async (client) => {
      await this.lockIdempotency(client, input)
      const replay = await this.replay(client, input)
      if (replay) return replay
      const currentResult = await client.query<IncidentRow>(`SELECT ${incidentColumns} FROM ops_incidents WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [workspaceId, input.incidentId])
      const row = currentResult.rows[0]
      if (!row) throw new IncidentRepositoryError('INCIDENT_NOT_FOUND', 'incident was not found')
      if (row.revision !== input.expectedRevision) throw new IncidentRepositoryError('INCIDENT_REVISION_CONFLICT', 'incident revision is stale')
      const current = mapIncident(row)
      if (input.operation === 'transition' && (current.status !== input.event.fromStatus || input.patch?.status !== input.event.toStatus)) throw new IncidentRepositoryError('INCIDENT_INVALID_TRANSITION', 'incident transition does not match current status')
      const status = input.patch?.status ?? current.status
      const commanderId = input.patch && 'commanderId' in input.patch ? input.patch.commanderId ?? null : current.commanderId ?? null
      const affectedComponents = input.patch?.affectedComponents ?? current.affectedComponents
      const affectedWorkspaceIds = input.patch?.affectedWorkspaceIds ?? current.affectedWorkspaceIds
      const incidentResult = await client.query<IncidentRow>(`UPDATE ops_incidents SET status=$3, commander_id=$4, affected_components=$5, affected_workspace_ids=$6, revision=revision+1, updated_at=now(), resolved_at=CASE WHEN $3='resolved' THEN now() ELSE NULL END WHERE workspace_id=$1 AND id=$2 AND revision=$7 RETURNING ${incidentColumns}`, [workspaceId, input.incidentId, status, commanderId, affectedComponents, affectedWorkspaceIds, input.expectedRevision])
      if (!incidentResult.rows[0]) throw new IncidentRepositoryError('INCIDENT_REVISION_CONFLICT', 'incident revision is stale')
      const incident = mapIncident(incidentResult.rows[0])
      const timelineResult = await client.query<TimelineRow>(`INSERT INTO ops_incident_timeline (id, workspace_id, incident_id, kind, body, from_status, to_status, actor_id, incident_revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${timelineColumns}`, [randomUUID(), workspaceId, input.incidentId, input.event.kind, input.event.body, input.event.fromStatus ?? null, input.event.toStatus ?? null, input.actorId, incident.revision])
      const result = { incident, event: mapTimeline(timelineResult.rows[0]!) }
      await this.remember(client, input, result)
      return result
    })
  }

  async listTimeline(input: { workspaceId: string; incidentId: string; limit: number; cursor?: string }): Promise<IncidentPage<IncidentTimelineEntry>> {
    requireWorkspaceScope(input.workspaceId)
    const limit = boundedLimit(input.limit, 200)
    const cursor = decodeCursor(input.cursor)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async (client) => {
      const exists = await client.query<{ exists: boolean }>('SELECT EXISTS(SELECT 1 FROM ops_incidents WHERE workspace_id=$1 AND id=$2) AS exists', [input.workspaceId, input.incidentId])
      if (!exists.rows[0]?.exists) throw new IncidentRepositoryError('INCIDENT_NOT_FOUND', 'incident was not found')
      const result = await client.query<TimelineRow>(`SELECT ${timelineColumns} FROM ops_incident_timeline WHERE workspace_id=$1 AND incident_id=$2 AND ($3::timestamptz IS NULL OR (created_at, id) > ($3::timestamptz, $4::uuid)) ORDER BY created_at ASC, id ASC LIMIT $5`, [input.workspaceId, input.incidentId, cursor?.at ?? null, cursor?.id ?? null, limit + 1])
      const hasMore = result.rows.length > limit
      const items = result.rows.slice(0, limit).map(mapTimeline)
      const last = items.at(-1)
      return { items, ...(hasMore && last ? { nextCursor: encodeCursor({ at: last.createdAt, id: last.id }) } : {}) }
    })
  }
}
