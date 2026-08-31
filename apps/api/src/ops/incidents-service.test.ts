import { describe, expect, it } from 'vitest'
import { MemoryIncidentRepository } from '../../../../packages/persistence/src/incidents-repository.js'
import type { IncidentActor } from '../../../../packages/contracts/src/ops/incidents.js'
import { IncidentsService } from './incidents-service.js'

const ops: IncidentActor = { actorId: 'ops_1', workspaceId: 'ws_1', roles: ['platform_ops'] }
const support: IncidentActor = { actorId: 'support_1', workspaceId: 'ws_1', roles: ['support'] }
const createInput = { title: 'Checkout unavailable', summary: 'Payment requests are failing', severity: 'sev1', affectedComponents: ['api'], affectedWorkspaceIds: ['ws_1'], idempotencyKey: 'incident:create:1' }

describe('incidents service', () => {
  it('enforces platform-ops mutation and support comment policy', async () => {
    const service = new IncidentsService(new MemoryIncidentRepository())
    await expect(service.create(support, createInput)).rejects.toMatchObject({ code: 'INCIDENT_FORBIDDEN' })
    const created = await service.create(ops, createInput)
    const commented = await service.comment(support, { incidentId: created.incident.id, expectedRevision: 1, body: 'Customer impact verified', idempotencyKey: 'incident:comment:1' })
    expect(commented.incident.revision).toBe(2)
    await expect(service.assignCommander(support, { incidentId: created.incident.id, expectedRevision: 2, commanderId: 'ops_2', note: 'Assign commander', idempotencyKey: 'incident:assign:1' })).rejects.toMatchObject({ code: 'INCIDENT_FORBIDDEN' })
  })

  it('allows only the forward incident lifecycle', async () => {
    const service = new IncidentsService(new MemoryIncidentRepository())
    let result = await service.create(ops, createInput)
    await expect(service.transition(ops, { incidentId: result.incident.id, expectedRevision: 1, toStatus: 'monitoring', note: 'Skip state', idempotencyKey: 'incident:transition:bad' })).rejects.toMatchObject({ code: 'INCIDENT_INVALID_TRANSITION' })
    for (const [toStatus, note, key] of [['identified', 'Root cause identified', 'incident:transition:1'], ['monitoring', 'Mitigation deployed', 'incident:transition:2'], ['resolved', 'Metrics recovered', 'incident:transition:3']] as const) {
      result = await service.transition(ops, { incidentId: result.incident.id, expectedRevision: result.incident.revision, toStatus, note, idempotencyKey: key })
      await expect(service.transition(ops, { incidentId: result.incident.id, expectedRevision: result.incident.revision - 1, toStatus, note, idempotencyKey: key })).resolves.toEqual(result)
    }
    expect(result.incident).toMatchObject({ status: 'resolved', revision: 4 })
    expect(result.incident.resolvedAt).toBeTruthy()
    await expect(service.transition(ops, { incidentId: result.incident.id, expectedRevision: 4, toStatus: 'identified', note: 'Reopen', idempotencyKey: 'incident:transition:4' })).rejects.toMatchObject({ code: 'INCIDENT_INVALID_TRANSITION' })
  })

  it('preserves tenant isolation and optimistic revision', async () => {
    const repository = new MemoryIncidentRepository()
    const service = new IncidentsService(repository)
    const created = await service.create(ops, createInput)
    await expect(service.get({ ...ops, workspaceId: 'ws_2' }, created.incident.id)).rejects.toMatchObject({ code: 'INCIDENT_NOT_FOUND' })
    await service.comment(support, { incidentId: created.incident.id, expectedRevision: 1, body: 'First note', idempotencyKey: 'incident:comment:1' })
    await expect(service.comment(support, { incidentId: created.incident.id, expectedRevision: 1, body: 'Stale note', idempotencyKey: 'incident:comment:2' })).rejects.toMatchObject({ code: 'INCIDENT_REVISION_CONFLICT' })
  })

  it('returns deterministic idempotent results', async () => {
    const service = new IncidentsService(new MemoryIncidentRepository())
    const first = await service.create(ops, createInput)
    await expect(service.create(ops, createInput)).resolves.toEqual(first)
    await expect(service.create(ops, { ...createInput, title: 'Different title' })).rejects.toMatchObject({ code: 'INCIDENT_IDEMPOTENCY_CONFLICT' })
  })
})
