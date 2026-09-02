import { createHash, randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlClient, type SqlPool, withWorkspaceTransaction } from './repository.js'

export type ServiceUnit = 'count' | 'minute' | 'contract_label'
export type ServiceFulfillmentEventType = 'scheduled' | 'started' | 'completed' | 'cancelled' | 'adjusted'
export type ServiceFulfillmentStatus = 'allocated' | 'scheduled' | 'in_progress' | 'completed' | 'cancelled'

export interface ServiceAllocationRecord {
  id: string
  workspaceId: string
  orderSnapshotId: string
  entitlementSnapshotId: string
  serviceType: string
  unit: ServiceUnit
  allocatedQuantity: number | null
  contractLabel: string | null
  periodStart: string | null
  periodEnd: string | null
  sourceChecksum: string
  createdByActorId: string
  creationReason: string
  creationEvidence: Record<string, unknown>
  revision: number
  status: ServiceFulfillmentStatus
  usedQuantity: number
  createdAt: string
  updatedAt: string
}

export interface ServiceFulfillmentEventRecord {
  id: string
  workspaceId: string
  allocationId: string
  type: ServiceFulfillmentEventType
  revision: number
  idempotencyKey: string
  actorId: string
  reason: string
  scheduleAt: string | null
  actualQuantity: number | null
  correctsEventId: string | null
  before: Record<string, unknown>
  after: Record<string, unknown>
  evidence: Record<string, unknown>
  createdAt: string
}

export interface OnboardingGrantScheduleRecord {
  id: string
  workspaceId: string
  onboardingOrderId: string
  entitlementSnapshotId: string
  sequence: number
  points: 500
  dueAt: null
  expiresAt: null
  status: 'unresolved'
  blockers: string[]
  sourceChecksum: string
  createdByActorId: string
  creationReason: string
  creationEvidence: Record<string, unknown>
  createdAt: string
}

export interface CreateServiceAllocationInput {
  workspaceId: string
  expectedRevision: 0
  idempotencyKey: string
  orderSnapshotId: string
  entitlementSnapshotId: string
  serviceType: string
  unit: ServiceUnit
  allocatedQuantity?: number | null
  contractLabel?: string | null
  periodStart?: string | null
  periodEnd?: string | null
  sourceChecksum: string
  actorId: string
  reason: string
  evidence: Record<string, unknown>
}

export interface AppendServiceFulfillmentEventInput {
  workspaceId: string
  allocationId: string
  type: ServiceFulfillmentEventType
  expectedRevision: number
  idempotencyKey: string
  actorId: string
  reason: string
  scheduleAt?: string | null
  actualQuantity?: number | null
  correctsEventId?: string | null
  evidence?: Record<string, unknown>
}

export interface SaveOnboardingGrantScheduleDraftInput {
  workspaceId: string
  onboardingOrderId: string
  entitlementSnapshotId: string
  sourceChecksum: string
  actorId: string
  reason: string
  evidence: Record<string, unknown>
}

export interface ServiceFulfillmentRepository {
  createAllocation(input: CreateServiceAllocationInput): Promise<ServiceAllocationRecord>
  appendEvent(input: AppendServiceFulfillmentEventInput): Promise<{ allocation: ServiceAllocationRecord; event: ServiceFulfillmentEventRecord }>
  listAllocations(workspaceId: string, limit?: number): Promise<ServiceAllocationRecord[]>
  listEvents(workspaceId: string, allocationId: string, limit?: number): Promise<ServiceFulfillmentEventRecord[]>
  saveOnboardingGrantScheduleDraft(input: SaveOnboardingGrantScheduleDraftInput): Promise<OnboardingGrantScheduleRecord[]>
  listOnboardingGrantSchedule(workspaceId: string, onboardingOrderId: string): Promise<OnboardingGrantScheduleRecord[]>
}

export type ServiceFulfillmentRepositoryErrorCode =
  | 'SERVICE_FULFILLMENT_INPUT_INVALID'
  | 'SERVICE_ALLOCATION_SOURCE_INVALID'
  | 'SERVICE_ALLOCATION_NOT_FOUND'
  | 'SERVICE_ALLOCATION_IDEMPOTENCY_CONFLICT'
  | 'SERVICE_FULFILLMENT_IDEMPOTENCY_CONFLICT'
  | 'SERVICE_FULFILLMENT_REVISION_CONFLICT'
  | 'SERVICE_FULFILLMENT_TRANSITION_INVALID'
  | 'SERVICE_FULFILLMENT_QUOTA_EXCEEDED'
  | 'SERVICE_FULFILLMENT_CORRECTION_INVALID'
  | 'ONBOARDING_GRANT_SCHEDULE_CONFLICT'

export class ServiceFulfillmentRepositoryError extends Error {
  constructor(readonly code: ServiceFulfillmentRepositoryErrorCode, message: string) {
    super(message)
    this.name = 'ServiceFulfillmentRepositoryError'
  }
}

const SHA256 = /^[a-f0-9]{64}$/u
const ONBOARDING_BLOCKERS = ['ONBOARDING_GRANT_START_DATE_UNRESOLVED', 'ONBOARDING_GRANT_EXPIRY_RULE_UNRESOLVED'] as const
const canonical = (value: unknown): string => JSON.stringify(normalize(value))
const normalize = (value: unknown): unknown => Array.isArray(value)
  ? value.map(normalize)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child)]))
    : value
const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex')
const clone = <T>(value: T): T => structuredClone(value)
const required = (value: string, field: string, max = 256): string => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new ServiceFulfillmentRepositoryError('SERVICE_FULFILLMENT_INPUT_INVALID', `${field} is invalid`)
  return value.trim()
}
const checksum = (value: string): string => {
  const result = required(value, 'sourceChecksum', 64)
  if (!SHA256.test(result)) throw new ServiceFulfillmentRepositoryError('SERVICE_FULFILLMENT_INPUT_INVALID', 'sourceChecksum is invalid')
  return result
}
const integer = (value: number | null | undefined, field: string): number | null => {
  if (value == null) return null
  if (!Number.isSafeInteger(value) || value < 0) throw new ServiceFulfillmentRepositoryError('SERVICE_FULFILLMENT_INPUT_INVALID', `${field} is invalid`)
  return value
}
const instant = (value: string | null | undefined, field: string): string | null => {
  if (value == null) return null
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new ServiceFulfillmentRepositoryError('SERVICE_FULFILLMENT_INPUT_INVALID', `${field} is invalid`)
  return value
}
const boundedObject = (value: Record<string, unknown> | undefined): Record<string, unknown> => {
  const result = value ?? {}
  if (!result || typeof result !== 'object' || Array.isArray(result) || Buffer.byteLength(JSON.stringify(result), 'utf8') > 32_768) throw new ServiceFulfillmentRepositoryError('SERVICE_FULFILLMENT_INPUT_INVALID', 'evidence is invalid')
  return clone(result)
}
const limit = (value = 100): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) throw new ServiceFulfillmentRepositoryError('SERVICE_FULFILLMENT_INPUT_INVALID', 'limit is invalid')
  return value
}

function validateAllocation(input: CreateServiceAllocationInput) {
  const workspaceId = requireWorkspaceScope(input.workspaceId)
  if (input.expectedRevision !== 0) throw new ServiceFulfillmentRepositoryError('SERVICE_FULFILLMENT_REVISION_CONFLICT', 'new service allocation requires expectedRevision 0')
  const unit = input.unit
  if (!['count', 'minute', 'contract_label'].includes(unit)) throw new ServiceFulfillmentRepositoryError('SERVICE_FULFILLMENT_INPUT_INVALID', 'unit is invalid')
  const allocatedQuantity = integer(input.allocatedQuantity, 'allocatedQuantity')
  const contractLabel = input.contractLabel == null ? null : required(input.contractLabel, 'contractLabel', 512)
  if (unit === 'contract_label' ? contractLabel === null || allocatedQuantity !== null : contractLabel !== null || allocatedQuantity === null) {
    throw new ServiceFulfillmentRepositoryError('SERVICE_FULFILLMENT_INPUT_INVALID', 'allocation quantity does not match unit')
  }
  const periodStart = instant(input.periodStart, 'periodStart')
  const periodEnd = instant(input.periodEnd, 'periodEnd')
  if ((periodStart === null) !== (periodEnd === null) || (periodStart && periodEnd && periodStart >= periodEnd)) throw new ServiceFulfillmentRepositoryError('SERVICE_FULFILLMENT_INPUT_INVALID', 'allocation period is invalid')
  const creationEvidence = boundedObject(input.evidence)
  if (Object.keys(creationEvidence).length === 0) throw new ServiceFulfillmentRepositoryError('SERVICE_FULFILLMENT_INPUT_INVALID', 'allocation creation requires evidence')
  return { workspaceId, expectedRevision: 0 as const, idempotencyKey: required(input.idempotencyKey, 'idempotencyKey'), orderSnapshotId: required(input.orderSnapshotId, 'orderSnapshotId'), entitlementSnapshotId: required(input.entitlementSnapshotId, 'entitlementSnapshotId'), serviceType: required(input.serviceType, 'serviceType', 128), unit, allocatedQuantity, contractLabel, periodStart, periodEnd, sourceChecksum: checksum(input.sourceChecksum), actorId: required(input.actorId, 'actorId'), reason: required(input.reason, 'reason', 1000), evidence: creationEvidence }
}

function validateEvent(input: AppendServiceFulfillmentEventInput) {
  const type = input.type
  if (!['scheduled', 'started', 'completed', 'cancelled', 'adjusted'].includes(type)) throw new ServiceFulfillmentRepositoryError('SERVICE_FULFILLMENT_INPUT_INVALID', 'event type is invalid')
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new ServiceFulfillmentRepositoryError('SERVICE_FULFILLMENT_INPUT_INVALID', 'expectedRevision is invalid')
  const scheduleAt = instant(input.scheduleAt, 'scheduleAt')
  const actualQuantity = integer(input.actualQuantity, 'actualQuantity')
  const correctsEventId = input.correctsEventId == null ? null : required(input.correctsEventId, 'correctsEventId')
  if (type === 'scheduled' && scheduleAt === null) throw new ServiceFulfillmentRepositoryError('SERVICE_FULFILLMENT_INPUT_INVALID', 'scheduled event requires scheduleAt')
  if (Object.keys(input.evidence ?? {}).length === 0) throw new ServiceFulfillmentRepositoryError('SERVICE_FULFILLMENT_INPUT_INVALID', 'service fulfillment event requires evidence')
  if (type === 'adjusted' && (correctsEventId === null || actualQuantity === null)) throw new ServiceFulfillmentRepositoryError('SERVICE_FULFILLMENT_INPUT_INVALID', 'adjusted event requires correction target and quantity')
  return { workspaceId: requireWorkspaceScope(input.workspaceId), allocationId: required(input.allocationId, 'allocationId'), type, expectedRevision: input.expectedRevision, idempotencyKey: required(input.idempotencyKey, 'idempotencyKey'), actorId: required(input.actorId, 'actorId'), reason: required(input.reason, 'reason', 1000), scheduleAt, actualQuantity, correctsEventId, evidence: boundedObject(input.evidence) }
}

const nextStatus = (current: ServiceFulfillmentStatus, type: ServiceFulfillmentEventType): ServiceFulfillmentStatus => {
  if (type === 'adjusted') return current
  if (type === 'scheduled' && ['allocated', 'completed', 'cancelled'].includes(current)) return 'scheduled'
  if (type === 'started' && current === 'scheduled') return 'in_progress'
  if (type === 'completed' && current === 'in_progress') return 'completed'
  if (type === 'cancelled' && ['scheduled', 'in_progress'].includes(current)) return 'cancelled'
  throw new ServiceFulfillmentRepositoryError('SERVICE_FULFILLMENT_TRANSITION_INVALID', `${current} cannot transition through ${type}`)
}

type AllocationRow = { id: string; workspace_id: string; order_snapshot_id: string; entitlement_snapshot_id: string; service_type: string; unit: ServiceUnit; allocated_quantity: number | string | null; contract_label: string | null; period_start: string | Date | null; period_end: string | Date | null; source_checksum: string; created_by_actor_id: string; creation_reason: string; creation_evidence: Record<string, unknown>; request_hash: string; revision: number | string; status: ServiceFulfillmentStatus; used_quantity: number | string; created_at: string | Date; updated_at: string | Date }
type EventRow = { id: string; workspace_id: string; allocation_id: string; event_type: ServiceFulfillmentEventType; revision: number | string; idempotency_key: string; request_hash: string; actor_id: string; reason: string; schedule_at: string | Date | null; actual_quantity: number | string | null; corrects_event_id: string | null; before_state: Record<string, unknown>; after_state: Record<string, unknown>; allocation_after: AllocationRow; evidence: Record<string, unknown>; created_at: string | Date }
type ScheduleRow = { id: string; workspace_id: string; onboarding_order_id: string; entitlement_snapshot_id: string; sequence: number | string; points: number | string; due_at: null; expires_at: null; status: 'blocked_policy_unresolved'; blockers: unknown; source_checksum: string; created_by_actor_id: string; creation_reason: string; creation_evidence: Record<string, unknown>; created_at: string | Date }
const iso = (value: string | Date | null): string | null => value === null ? null : value instanceof Date ? value.toISOString() : value
const number = (value: number | string): number => typeof value === 'number' ? value : Number(value)
const mapAllocation = (row: AllocationRow): ServiceAllocationRecord => ({ id: row.id, workspaceId: row.workspace_id, orderSnapshotId: row.order_snapshot_id, entitlementSnapshotId: row.entitlement_snapshot_id, serviceType: row.service_type, unit: row.unit, allocatedQuantity: row.allocated_quantity === null ? null : number(row.allocated_quantity), contractLabel: row.contract_label, periodStart: iso(row.period_start), periodEnd: iso(row.period_end), sourceChecksum: row.source_checksum, createdByActorId: row.created_by_actor_id, creationReason: row.creation_reason, creationEvidence: clone(row.creation_evidence), revision: number(row.revision), status: row.status, usedQuantity: number(row.used_quantity), createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)! })
const mapEvent = (row: EventRow): ServiceFulfillmentEventRecord => ({ id: row.id, workspaceId: row.workspace_id, allocationId: row.allocation_id, type: row.event_type, revision: number(row.revision), idempotencyKey: row.idempotency_key, actorId: row.actor_id, reason: row.reason, scheduleAt: iso(row.schedule_at), actualQuantity: row.actual_quantity === null ? null : number(row.actual_quantity), correctsEventId: row.corrects_event_id, before: clone(row.before_state), after: clone(row.after_state), evidence: clone(row.evidence), createdAt: iso(row.created_at)! })
const mapSchedule = (row: ScheduleRow): OnboardingGrantScheduleRecord => ({ id: row.id, workspaceId: row.workspace_id, onboardingOrderId: row.onboarding_order_id, entitlementSnapshotId: row.entitlement_snapshot_id, sequence: number(row.sequence), points: 500, dueAt: null, expiresAt: null, status: 'unresolved', blockers: Array.isArray(row.blockers) ? row.blockers.filter((value): value is string => typeof value === 'string') : [], sourceChecksum: row.source_checksum, createdByActorId: row.created_by_actor_id, creationReason: row.creation_reason, creationEvidence: clone(row.creation_evidence), createdAt: iso(row.created_at)! })
const allocationProjection = 'id,workspace_id,order_snapshot_id,entitlement_snapshot_id,service_type,unit,allocated_quantity,contract_label,period_start,period_end,source_checksum,created_by_actor_id,creation_reason,creation_evidence,request_hash,revision,status,used_quantity,created_at,updated_at'
const eventProjection = `id,workspace_id,allocation_id,event_type,revision,idempotency_key,request_hash,actor_id,reason,schedule_at,actual_quantity,corrects_event_id,before_state,after_state,allocation_after,evidence,created_at`
const scheduleProjection = 'id,workspace_id,onboarding_order_id,entitlement_snapshot_id,sequence,points,due_at,expires_at,status,blockers,source_checksum,created_by_actor_id,creation_reason,creation_evidence,created_at'

export class PostgresServiceFulfillmentRepository implements ServiceFulfillmentRepository {
  constructor(private readonly pool: SqlPool) {}

  async createAllocation(input: CreateServiceAllocationInput): Promise<ServiceAllocationRecord> {
    const value = validateAllocation(input); const requestHash = hash(value)
    return withWorkspaceTransaction(this.pool, value.workspaceId, async client => {
      const source = await client.query(
        `SELECT 1
           FROM commercial_order_snapshots_v2 os
           JOIN workspace_subscription_periods_v2 sp
             ON sp.workspace_id=os.workspace_id AND sp.order_snapshot_id=os.id
           JOIN workspace_entitlement_snapshots_v2 es
             ON es.workspace_id=sp.workspace_id
            AND es.subscription_period_id=sp.id
            AND es.subscription_period_revision=sp.revision
          WHERE os.workspace_id=$1 AND os.id=$2 AND es.id=$3
            AND es.executable=true AND es.unresolved_blockers='[]'::jsonb
          LIMIT 1`,
        [value.workspaceId, value.orderSnapshotId, value.entitlementSnapshotId],
      )
      if (!source.rows[0]) throw new ServiceFulfillmentRepositoryError('SERVICE_ALLOCATION_SOURCE_INVALID', 'service allocation requires one executable entitlement snapshot bound to the order snapshot')
      const inserted = await client.query<AllocationRow>(`INSERT INTO workspace_service_allocations (id,workspace_id,idempotency_key,request_hash,order_snapshot_id,entitlement_snapshot_id,service_type,unit,allocated_quantity,contract_label,period_start,period_end,source_checksum,created_by_actor_id,creation_reason,creation_evidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb) ON CONFLICT (workspace_id,idempotency_key) DO NOTHING RETURNING ${allocationProjection}`, [`svc_${randomUUID()}`, value.workspaceId, value.idempotencyKey, requestHash, value.orderSnapshotId, value.entitlementSnapshotId, value.serviceType, value.unit, value.allocatedQuantity, value.contractLabel, value.periodStart, value.periodEnd, value.sourceChecksum, value.actorId, value.reason, JSON.stringify(value.evidence)])
      if (inserted.rows[0]) return mapAllocation(inserted.rows[0])
      const replay = await client.query<AllocationRow>(`SELECT ${allocationProjection} FROM workspace_service_allocations WHERE workspace_id=$1 AND idempotency_key=$2`, [value.workspaceId, value.idempotencyKey])
      if (!replay.rows[0] || replay.rows[0].request_hash !== requestHash) throw new ServiceFulfillmentRepositoryError('SERVICE_ALLOCATION_IDEMPOTENCY_CONFLICT', 'allocation idempotency key conflicts with a different intent')
      return mapAllocation(replay.rows[0])
    })
  }

  async appendEvent(input: AppendServiceFulfillmentEventInput): Promise<{ allocation: ServiceAllocationRecord; event: ServiceFulfillmentEventRecord }> {
    const value = validateEvent(input); const requestHash = hash(value)
    return withWorkspaceTransaction(this.pool, value.workspaceId, async client => {
      const replay = await client.query<EventRow>(`SELECT ${eventProjection} FROM workspace_service_fulfillment_events WHERE workspace_id=$1 AND idempotency_key=$2`, [value.workspaceId, value.idempotencyKey])
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== requestHash) throw new ServiceFulfillmentRepositoryError('SERVICE_FULFILLMENT_IDEMPOTENCY_CONFLICT', 'event idempotency key conflicts with a different intent')
        return { allocation: mapAllocation(replay.rows[0].allocation_after), event: mapEvent(replay.rows[0]) }
      }
      const locked = await client.query<AllocationRow>(`SELECT ${allocationProjection} FROM workspace_service_allocations WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [value.workspaceId, value.allocationId])
      const current = locked.rows[0]
      if (!current) throw new ServiceFulfillmentRepositoryError('SERVICE_ALLOCATION_NOT_FOUND', 'service allocation was not found in workspace')
      const concurrentReplay = await client.query<EventRow>(`SELECT ${eventProjection} FROM workspace_service_fulfillment_events WHERE workspace_id=$1 AND idempotency_key=$2`, [value.workspaceId, value.idempotencyKey])
      if (concurrentReplay.rows[0]) {
        if (concurrentReplay.rows[0].request_hash !== requestHash) throw new ServiceFulfillmentRepositoryError('SERVICE_FULFILLMENT_IDEMPOTENCY_CONFLICT', 'event idempotency key conflicts with a different intent')
        return { allocation: mapAllocation(concurrentReplay.rows[0].allocation_after), event: mapEvent(concurrentReplay.rows[0]) }
      }
      if (number(current.revision) !== value.expectedRevision) throw new ServiceFulfillmentRepositoryError('SERVICE_FULFILLMENT_REVISION_CONFLICT', 'service allocation revision changed')
      if (value.type === 'completed' && current.unit !== 'contract_label' && (value.actualQuantity === null || value.actualQuantity < 1)) throw new ServiceFulfillmentRepositoryError('SERVICE_FULFILLMENT_INPUT_INVALID', 'completed count/minute service requires a positive actualQuantity')
      const status = nextStatus(current.status, value.type)
      let usedQuantity = number(current.used_quantity)
      let beforeActual: number | null = null
      if (value.type === 'completed') usedQuantity += value.actualQuantity ?? 0
      if (value.type === 'adjusted') {
        const corrected = await client.query<EventRow>(`SELECT ${eventProjection} FROM workspace_service_fulfillment_events WHERE workspace_id=$1 AND allocation_id=$2 AND id=$3`, [value.workspaceId, value.allocationId, value.correctsEventId])
        const target = corrected.rows[0]
        if (!target || !['completed', 'adjusted'].includes(target.event_type) || target.actual_quantity === null) throw new ServiceFulfillmentRepositoryError('SERVICE_FULFILLMENT_CORRECTION_INVALID', 'correction target is not an auditable quantity event')
        beforeActual = number(target.actual_quantity)
        usedQuantity += value.actualQuantity! - beforeActual
      }
      if (usedQuantity < 0 || (current.allocated_quantity !== null && usedQuantity > number(current.allocated_quantity))) throw new ServiceFulfillmentRepositoryError('SERVICE_FULFILLMENT_QUOTA_EXCEEDED', 'service fulfillment exceeds contracted allocation')
      const revision = number(current.revision) + 1
      const updated = await client.query<AllocationRow>(`UPDATE workspace_service_allocations SET revision=$3,status=$4,used_quantity=$5,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING ${allocationProjection}`, [value.workspaceId, value.allocationId, revision, status, usedQuantity])
      const allocationAfter = updated.rows[0]
      if (!allocationAfter) throw new ServiceFulfillmentRepositoryError('SERVICE_ALLOCATION_NOT_FOUND', 'service allocation disappeared')
      const before = { revision: number(current.revision), status: current.status, usedQuantity: number(current.used_quantity), correctedActualQuantity: beforeActual }
      const after = { revision, status, usedQuantity, correctedActualQuantity: value.type === 'adjusted' ? value.actualQuantity : null }
      const event = await client.query<EventRow>(`INSERT INTO workspace_service_fulfillment_events (id,workspace_id,allocation_id,event_type,revision,idempotency_key,request_hash,actor_id,reason,schedule_at,actual_quantity,corrects_event_id,before_state,after_state,allocation_after,evidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb) RETURNING ${eventProjection}`, [`svce_${randomUUID()}`, value.workspaceId, value.allocationId, value.type, revision, value.idempotencyKey, requestHash, value.actorId, value.reason, value.scheduleAt, value.actualQuantity, value.correctsEventId, JSON.stringify(before), JSON.stringify(after), JSON.stringify(allocationAfter), JSON.stringify(value.evidence)])
      if (!event.rows[0]) throw new Error('service fulfillment event insert failed')
      return { allocation: mapAllocation(allocationAfter), event: mapEvent(event.rows[0]) }
    })
  }

  async listAllocations(workspaceId: string, requestedLimit = 100): Promise<ServiceAllocationRecord[]> {
    const scope = requireWorkspaceScope(workspaceId); const take = limit(requestedLimit)
    return withWorkspaceTransaction(this.pool, scope, async client => (await client.query<AllocationRow>(`SELECT ${allocationProjection} FROM workspace_service_allocations WHERE workspace_id=$1 ORDER BY updated_at DESC,id DESC LIMIT $2`, [scope, take])).rows.map(mapAllocation))
  }

  async listEvents(workspaceId: string, allocationId: string, requestedLimit = 100): Promise<ServiceFulfillmentEventRecord[]> {
    const scope = requireWorkspaceScope(workspaceId); const id = required(allocationId, 'allocationId'); const take = limit(requestedLimit)
    return withWorkspaceTransaction(this.pool, scope, async client => (await client.query<EventRow>(`SELECT ${eventProjection} FROM workspace_service_fulfillment_events WHERE workspace_id=$1 AND allocation_id=$2 ORDER BY revision ASC LIMIT $3`, [scope, id, take])).rows.map(mapEvent))
  }

  async saveOnboardingGrantScheduleDraft(input: SaveOnboardingGrantScheduleDraftInput): Promise<OnboardingGrantScheduleRecord[]> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const onboardingOrderId = required(input.onboardingOrderId, 'onboardingOrderId'); const entitlementSnapshotId = required(input.entitlementSnapshotId, 'entitlementSnapshotId'); const sourceChecksum = checksum(input.sourceChecksum); const actorId = required(input.actorId, 'actorId'); const reason = required(input.reason, 'reason', 1000); const evidence = boundedObject(input.evidence)
    if (Object.keys(evidence).length === 0) throw new ServiceFulfillmentRepositoryError('SERVICE_FULFILLMENT_INPUT_INVALID', 'onboarding schedule requires source evidence')
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      for (let sequence = 1; sequence <= 6; sequence += 1) {
        await client.query(`INSERT INTO onboarding_point_grant_schedules_v2 (id,workspace_id,onboarding_order_id,entitlement_snapshot_id,sequence,points,due_at,expires_at,status,blockers,source_checksum,created_by_actor_id,creation_reason,creation_evidence) VALUES ($1,$2,$3,$4,$5,500,NULL,NULL,'blocked_policy_unresolved',$6::jsonb,$7,$8,$9,$10::jsonb) ON CONFLICT (workspace_id,onboarding_order_id,sequence) DO NOTHING`, [`opgs_${hash({ workspaceId, onboardingOrderId, sequence }).slice(0, 28)}`, workspaceId, onboardingOrderId, entitlementSnapshotId, sequence, JSON.stringify(ONBOARDING_BLOCKERS), sourceChecksum, actorId, reason, JSON.stringify(evidence)])
      }
      const rows = await client.query<ScheduleRow>(`SELECT ${scheduleProjection} FROM onboarding_point_grant_schedules_v2 WHERE workspace_id=$1 AND onboarding_order_id=$2 ORDER BY sequence ASC`, [workspaceId, onboardingOrderId])
      if (rows.rows.length !== 6 || rows.rows.some(row => row.entitlement_snapshot_id !== entitlementSnapshotId || row.source_checksum !== sourceChecksum || row.created_by_actor_id !== actorId || row.creation_reason !== reason || canonical(row.creation_evidence) !== canonical(evidence) || number(row.points) !== 500 || row.status !== 'blocked_policy_unresolved' || row.due_at !== null || row.expires_at !== null)) throw new ServiceFulfillmentRepositoryError('ONBOARDING_GRANT_SCHEDULE_CONFLICT', 'existing onboarding schedule does not match the unresolved six-by-500 draft')
      return rows.rows.map(mapSchedule)
    })
  }

  async listOnboardingGrantSchedule(workspaceId: string, onboardingOrderId: string): Promise<OnboardingGrantScheduleRecord[]> {
    const scope = requireWorkspaceScope(workspaceId); const orderId = required(onboardingOrderId, 'onboardingOrderId')
    return withWorkspaceTransaction(this.pool, scope, async client => (await client.query<ScheduleRow>(`SELECT ${scheduleProjection} FROM onboarding_point_grant_schedules_v2 WHERE workspace_id=$1 AND onboarding_order_id=$2 ORDER BY sequence ASC`, [scope, orderId])).rows.map(mapSchedule))
  }
}
