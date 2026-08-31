import { describe, expect, it } from 'vitest'
import { IncidentRequestGate, incidentNextStatus, mergeIncidentPage, mergeTimelinePage, type IncidentTimelineEntry, type OpsIncident } from './useIncidents.js'

const incident = (id: string, updatedAt: string): OpsIncident => ({ id, workspaceId: 'ws_1', title: id, summary: 'summary', severity: 'sev2', status: 'investigating', affectedComponents: [], affectedWorkspaceIds: [], revision: 1, createdBy: 'ops_1', createdAt: updatedAt, updatedAt })

describe('incident hook helpers', () => {
  it('merges cursor pages without duplicates using stable ordering', () => {
    expect(mergeIncidentPage([incident('a', '2026-01-01T00:00:00.000Z')], [incident('a', '2026-01-03T00:00:00.000Z'), incident('b', '2026-01-02T00:00:00.000Z')]).map((item) => item.id)).toEqual(['a', 'b'])
  })

  it('exposes the strict lifecycle to the UI', () => {
    expect(incidentNextStatus).toEqual({ investigating: 'identified', identified: 'monitoring', monitoring: 'resolved', resolved: undefined })
  })

  it('merges replayed timeline events once in chronological order', () => {
    const event = (id: string, createdAt: string): IncidentTimelineEntry => ({ id, workspaceId: 'ws_1', incidentId: 'incident_1', kind: 'comment', body: id, actorId: 'support_1', incidentRevision: 2, createdAt })
    expect(mergeTimelinePage([event('b', '2026-01-02T00:00:00.000Z')], [event('b', '2026-01-02T00:00:00.000Z'), event('a', '2026-01-01T00:00:00.000Z')]).map((item) => item.id)).toEqual(['a', 'b'])
  })

  it('prevents an older page or timeline response from replacing the latest request', () => {
    const gate = new IncidentRequestGate()
    const first = gate.begin()
    const second = gate.begin()
    expect(gate.isCurrent(first)).toBe(false)
    expect(gate.isCurrent(second)).toBe(true)
    gate.invalidate()
    expect(gate.isCurrent(second)).toBe(false)
  })
})
