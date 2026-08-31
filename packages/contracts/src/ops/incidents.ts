export const incidentSeverities = ['sev1', 'sev2', 'sev3', 'sev4'] as const
export const incidentStatuses = ['investigating', 'identified', 'monitoring', 'resolved'] as const

export type IncidentSeverity = (typeof incidentSeverities)[number]
export type IncidentStatus = (typeof incidentStatuses)[number]
export type IncidentRole = 'support' | 'platform_ops'

export interface OpsIncident {
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

export type IncidentTimelineKind =
  | 'created'
  | 'comment'
  | 'status_changed'
  | 'commander_changed'
  | 'scope_changed'

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

export interface IncidentPage {
  items: OpsIncident[]
  nextCursor?: string
}

export interface IncidentTimelinePage {
  items: IncidentTimelineEntry[]
  nextCursor?: string
}

export interface IncidentActor {
  actorId: string
  workspaceId: string
  roles: readonly IncidentRole[]
}

export interface CreateIncidentParams {
  title: string
  summary: string
  severity: IncidentSeverity
  commanderId?: string
  affectedComponents: string[]
  affectedWorkspaceIds: string[]
  idempotencyKey: string
}

export interface TransitionIncidentParams {
  incidentId: string
  expectedRevision: number
  toStatus: IncidentStatus
  note: string
  idempotencyKey: string
}

export interface CommentIncidentParams {
  incidentId: string
  expectedRevision: number
  body: string
  idempotencyKey: string
}

export interface AssignIncidentCommanderParams {
  incidentId: string
  expectedRevision: number
  commanderId?: string
  note: string
  idempotencyKey: string
}

export interface UpdateIncidentScopeParams {
  incidentId: string
  expectedRevision: number
  affectedComponents: string[]
  affectedWorkspaceIds: string[]
  note: string
  idempotencyKey: string
}

export interface ListIncidentsParams {
  status?: IncidentStatus
  severity?: IncidentSeverity
  limit?: number
  cursor?: string
}

export interface ListIncidentTimelineParams {
  incidentId: string
  limit?: number
  cursor?: string
}

export class IncidentContractError extends Error {
  readonly code = 'INCIDENT_INVALID_REQUEST'
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IncidentContractError('request must be an object')
  return value as Record<string, unknown>
}

const string = (value: unknown, field: string, min: number, max: number): string => {
  if (typeof value !== 'string') throw new IncidentContractError(`${field} must be a string`)
  const normalized = value.trim()
  if (normalized.length < min || normalized.length > max) throw new IncidentContractError(`${field} must contain ${min}-${max} characters`)
  return normalized
}

const optionalString = (value: unknown, field: string, max: number): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined
  return string(value, field, 1, max)
}

const positiveRevision = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new IncidentContractError('expectedRevision must be a positive integer')
  return Number(value)
}

const stringList = (value: unknown, field: string, maxItems: number): string[] => {
  if (!Array.isArray(value)) throw new IncidentContractError(`${field} must be an array`)
  if (value.length > maxItems) throw new IncidentContractError(`${field} must contain at most ${maxItems} items`)
  const normalized = value.map((item) => string(item, field, 1, 160))
  return [...new Set(normalized)].sort((a, b) => a.localeCompare(b))
}

const enumValue = <Value extends string>(value: unknown, values: readonly Value[], field: string): Value => {
  if (typeof value !== 'string' || !values.includes(value as Value)) throw new IncidentContractError(`${field} is invalid`)
  return value as Value
}

const key = (value: unknown): string => {
  const normalized = string(value, 'idempotencyKey', 8, 128)
  if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) throw new IncidentContractError('idempotencyKey contains unsupported characters')
  return normalized
}

export function parseCreateIncidentParams(value: unknown): CreateIncidentParams {
  const input = object(value)
  return {
    title: string(input.title, 'title', 3, 160),
    summary: string(input.summary, 'summary', 3, 4000),
    severity: enumValue(input.severity, incidentSeverities, 'severity'),
    ...(optionalString(input.commanderId, 'commanderId', 160) ? { commanderId: optionalString(input.commanderId, 'commanderId', 160) } : {}),
    affectedComponents: stringList(input.affectedComponents ?? [], 'affectedComponents', 100),
    affectedWorkspaceIds: stringList(input.affectedWorkspaceIds ?? [], 'affectedWorkspaceIds', 500),
    idempotencyKey: key(input.idempotencyKey),
  }
}

export function parseTransitionIncidentParams(value: unknown): TransitionIncidentParams {
  const input = object(value)
  return {
    incidentId: string(input.incidentId, 'incidentId', 1, 160),
    expectedRevision: positiveRevision(input.expectedRevision),
    toStatus: enumValue(input.toStatus, incidentStatuses, 'toStatus'),
    note: string(input.note, 'note', 3, 4000),
    idempotencyKey: key(input.idempotencyKey),
  }
}

export function parseCommentIncidentParams(value: unknown): CommentIncidentParams {
  const input = object(value)
  return {
    incidentId: string(input.incidentId, 'incidentId', 1, 160),
    expectedRevision: positiveRevision(input.expectedRevision),
    body: string(input.body, 'body', 1, 4000),
    idempotencyKey: key(input.idempotencyKey),
  }
}

export function parseAssignIncidentCommanderParams(value: unknown): AssignIncidentCommanderParams {
  const input = object(value)
  const commanderId = optionalString(input.commanderId, 'commanderId', 160)
  return {
    incidentId: string(input.incidentId, 'incidentId', 1, 160),
    expectedRevision: positiveRevision(input.expectedRevision),
    ...(commanderId ? { commanderId } : {}),
    note: string(input.note, 'note', 3, 4000),
    idempotencyKey: key(input.idempotencyKey),
  }
}

export function parseUpdateIncidentScopeParams(value: unknown): UpdateIncidentScopeParams {
  const input = object(value)
  return {
    incidentId: string(input.incidentId, 'incidentId', 1, 160),
    expectedRevision: positiveRevision(input.expectedRevision),
    affectedComponents: stringList(input.affectedComponents, 'affectedComponents', 100),
    affectedWorkspaceIds: stringList(input.affectedWorkspaceIds, 'affectedWorkspaceIds', 500),
    note: string(input.note, 'note', 3, 4000),
    idempotencyKey: key(input.idempotencyKey),
  }
}

export function parseListIncidentsParams(value: unknown): ListIncidentsParams {
  const input = object(value ?? {})
  const limit = input.limit === undefined ? 50 : Number(input.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new IncidentContractError('limit must be an integer between 1 and 100')
  return {
    ...(input.status === undefined ? {} : { status: enumValue(input.status, incidentStatuses, 'status') }),
    ...(input.severity === undefined ? {} : { severity: enumValue(input.severity, incidentSeverities, 'severity') }),
    limit,
    ...(optionalString(input.cursor, 'cursor', 1000) ? { cursor: optionalString(input.cursor, 'cursor', 1000) } : {}),
  }
}

export function parseListIncidentTimelineParams(value: unknown): ListIncidentTimelineParams {
  const input = object(value)
  const limit = input.limit === undefined ? 100 : Number(input.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new IncidentContractError('limit must be an integer between 1 and 200')
  return {
    incidentId: string(input.incidentId, 'incidentId', 1, 160),
    limit,
    ...(optionalString(input.cursor, 'cursor', 1000) ? { cursor: optionalString(input.cursor, 'cursor', 1000) } : {}),
  }
}
