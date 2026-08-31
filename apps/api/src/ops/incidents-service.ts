import { createHash } from 'node:crypto'
import {
  parseAssignIncidentCommanderParams,
  parseCommentIncidentParams,
  parseCreateIncidentParams,
  parseListIncidentsParams,
  parseListIncidentTimelineParams,
  parseTransitionIncidentParams,
  parseUpdateIncidentScopeParams,
  type IncidentActor,
  type IncidentStatus,
} from '../../../../packages/contracts/src/ops/incidents.js'
import type { IncidentRepository } from '../../../../packages/persistence/src/incidents-repository.js'

export class IncidentServiceError extends Error {
  constructor(readonly code: 'INCIDENT_FORBIDDEN' | 'INCIDENT_NOT_FOUND' | 'INCIDENT_INVALID_TRANSITION', message: string) {
    super(message)
    this.name = 'IncidentServiceError'
  }
}

const previousStatus: Partial<Record<IncidentStatus, IncidentStatus>> = {
  identified: 'investigating',
  monitoring: 'identified',
  resolved: 'monitoring',
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function requireWorkspace(actor: IncidentActor): string {
  const workspaceId = actor.workspaceId.trim()
  if (!workspaceId) throw new IncidentServiceError('INCIDENT_FORBIDDEN', 'workspace scope is required')
  if (!actor.actorId.trim()) throw new IncidentServiceError('INCIDENT_FORBIDDEN', 'authenticated actor is required')
  return workspaceId
}

function canRead(actor: IncidentActor): boolean {
  return actor.roles.includes('support') || actor.roles.includes('platform_ops')
}

function requireRead(actor: IncidentActor): void {
  requireWorkspace(actor)
  if (!canRead(actor)) throw new IncidentServiceError('INCIDENT_FORBIDDEN', 'support or platform operations role is required')
}

function requireMutation(actor: IncidentActor): void {
  requireWorkspace(actor)
  if (!actor.roles.includes('platform_ops')) throw new IncidentServiceError('INCIDENT_FORBIDDEN', 'platform operations role is required')
}

export class IncidentsService {
  constructor(private readonly repository: IncidentRepository) {}

  async list(actor: IncidentActor, raw: unknown = {}) {
    requireRead(actor)
    const input = parseListIncidentsParams(raw)
    return this.repository.list({ workspaceId: actor.workspaceId, ...input, limit: input.limit ?? 50 })
  }

  async get(actor: IncidentActor, incidentId: string) {
    requireRead(actor)
    const incident = await this.repository.get(actor.workspaceId, incidentId.trim())
    if (!incident) throw new IncidentServiceError('INCIDENT_NOT_FOUND', 'incident was not found')
    return incident
  }

  async timeline(actor: IncidentActor, raw: unknown) {
    requireRead(actor)
    const input = parseListIncidentTimelineParams(raw)
    return this.repository.listTimeline({ workspaceId: actor.workspaceId, ...input, limit: input.limit ?? 100 })
  }

  async create(actor: IncidentActor, raw: unknown) {
    requireMutation(actor)
    const input = parseCreateIncidentParams(raw)
    return this.repository.create({
      workspaceId: actor.workspaceId,
      actorId: actor.actorId,
      ...input,
      requestHash: requestHash({ operation: 'create', workspaceId: actor.workspaceId, ...input }),
    })
  }

  async transition(actor: IncidentActor, raw: unknown) {
    requireMutation(actor)
    const input = parseTransitionIncidentParams(raw)
    const fromStatus = previousStatus[input.toStatus]
    if (!fromStatus) throw new IncidentServiceError('INCIDENT_INVALID_TRANSITION', 'incident cannot transition to investigating')
    return this.repository.mutate({
      workspaceId: actor.workspaceId,
      incidentId: input.incidentId,
      actorId: actor.actorId,
      expectedRevision: input.expectedRevision,
      operation: 'transition',
      idempotencyKey: input.idempotencyKey,
      requestHash: requestHash({ operation: 'transition', workspaceId: actor.workspaceId, ...input }),
      event: { kind: 'status_changed', body: input.note, fromStatus, toStatus: input.toStatus },
      patch: { status: input.toStatus },
    })
  }

  async comment(actor: IncidentActor, raw: unknown) {
    requireRead(actor)
    const input = parseCommentIncidentParams(raw)
    return this.repository.mutate({
      workspaceId: actor.workspaceId,
      incidentId: input.incidentId,
      actorId: actor.actorId,
      expectedRevision: input.expectedRevision,
      operation: 'comment',
      idempotencyKey: input.idempotencyKey,
      requestHash: requestHash({ operation: 'comment', workspaceId: actor.workspaceId, ...input }),
      event: { kind: 'comment', body: input.body },
    })
  }

  async assignCommander(actor: IncidentActor, raw: unknown) {
    requireMutation(actor)
    const input = parseAssignIncidentCommanderParams(raw)
    return this.repository.mutate({
      workspaceId: actor.workspaceId,
      incidentId: input.incidentId,
      actorId: actor.actorId,
      expectedRevision: input.expectedRevision,
      operation: 'assign_commander',
      idempotencyKey: input.idempotencyKey,
      requestHash: requestHash({ operation: 'assign_commander', workspaceId: actor.workspaceId, ...input }),
      event: { kind: 'commander_changed', body: input.note },
      patch: { commanderId: input.commanderId ?? null },
    })
  }

  async updateScope(actor: IncidentActor, raw: unknown) {
    requireMutation(actor)
    const input = parseUpdateIncidentScopeParams(raw)
    return this.repository.mutate({
      workspaceId: actor.workspaceId,
      incidentId: input.incidentId,
      actorId: actor.actorId,
      expectedRevision: input.expectedRevision,
      operation: 'update_scope',
      idempotencyKey: input.idempotencyKey,
      requestHash: requestHash({ operation: 'update_scope', workspaceId: actor.workspaceId, ...input }),
      event: { kind: 'scope_changed', body: input.note },
      patch: { affectedComponents: input.affectedComponents, affectedWorkspaceIds: input.affectedWorkspaceIds },
    })
  }
}
