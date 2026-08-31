import { describe, expect, it } from 'vitest'
import { parseCreateIncidentParams, parseListIncidentsParams, parseTransitionIncidentParams } from './incidents.js'

describe('incident contracts', () => {
  it('normalizes scope lists and validates severity', () => {
    expect(parseCreateIncidentParams({ title: 'API outage', summary: 'Requests are failing', severity: 'sev1', affectedComponents: ['api', 'api', 'worker'], affectedWorkspaceIds: ['ws_b', 'ws_a'], idempotencyKey: 'incident:create:1' })).toMatchObject({ affectedComponents: ['api', 'worker'], affectedWorkspaceIds: ['ws_a', 'ws_b'] })
    expect(() => parseCreateIncidentParams({ title: 'Bad', summary: 'Bad input', severity: 'critical', idempotencyKey: 'incident:create:2' })).toThrow('severity is invalid')
  })

  it('rejects invalid optimistic revisions and unsafe idempotency keys', () => {
    expect(() => parseTransitionIncidentParams({ incidentId: 'i1', expectedRevision: 0, toStatus: 'identified', note: 'Root cause found', idempotencyKey: 'incident:transition:1' })).toThrow('positive integer')
    expect(() => parseTransitionIncidentParams({ incidentId: 'i1', expectedRevision: 1, toStatus: 'identified', note: 'Root cause found', idempotencyKey: 'contains spaces' })).toThrow('unsupported characters')
  })

  it('bounds stable page sizes', () => {
    expect(parseListIncidentsParams({ limit: 100 })).toEqual({ limit: 100 })
    expect(() => parseListIncidentsParams({ limit: 101 })).toThrow('between 1 and 100')
  })
})
