import { describe, expect, it } from 'vitest'
import {
  MCP_METHOD_SCHEMAS,
  auditSources,
  financeRecordKinds,
  incidentSeverities,
  incidentStatuses,
  supportTicketPriorities,
  supportTicketStatuses,
} from './index.js'

describe('Ops domain MCP integration', () => {
  it('keeps MCP enums aligned with the domain contracts', () => {
    expect(MCP_METHOD_SCHEMAS['ops.support.tickets.list'].properties.status?.enum).toEqual(supportTicketStatuses)
    expect(MCP_METHOD_SCHEMAS['ops.support.tickets.list'].properties.priority?.enum).toEqual(supportTicketPriorities)
    expect(MCP_METHOD_SCHEMAS['ops.incidents.list'].properties.status?.enum).toEqual(incidentStatuses)
    expect(MCP_METHOD_SCHEMAS['ops.incidents.list'].properties.severity?.enum).toEqual(incidentSeverities)
    expect(MCP_METHOD_SCHEMAS['ops.support.tickets.list'].properties.platform_scope?.enum).toEqual(['platform'])
    expect(MCP_METHOD_SCHEMAS['ops.incidents.list'].properties.platform_scope?.enum).toEqual(['platform'])
    expect(MCP_METHOD_SCHEMAS['ops.finance.detail'].properties.kind?.enum).toEqual(financeRecordKinds)
    expect(MCP_METHOD_SCHEMAS['ops.audit.detail'].properties.source?.enum).toEqual(auditSources)
  })

  it('requires concurrency and audit evidence on every operator mutation', () => {
    const mutationMethods = [
      'ops.support.ticket.assign',
      'ops.support.ticket.transition',
      'ops.support.ticket.comment',
      'ops.incident.transition',
      'ops.incident.comment',
      'ops.incident.commander.assign',
      'ops.incident.scope.update',
      'ops.feature-flag.emergency.set',
    ] as const

    for (const method of mutationMethods) {
      expect(MCP_METHOD_SCHEMAS[method].required, method).toContain('expected_revision')
      expect(MCP_METHOD_SCHEMAS[method].required, method).toContain('idempotency_key')
    }
    for (const method of ['ops.support.ticket.transition', 'ops.incident.transition', 'ops.incident.commander.assign', 'ops.incident.scope.update', 'ops.feature-flag.emergency.set'] as const) {
      const required = MCP_METHOD_SCHEMAS[method].required ?? []
      expect(required.some(field => field === 'reason' || field === 'note'), method).toBe(true)
    }
  })

  it('keeps member governance aligned with the server concurrency boundary', () => {
    expect(MCP_METHOD_SCHEMAS['ops.member.upsert'].required).toEqual([
      'external_subject', 'role', 'reason',
    ])
    expect(MCP_METHOD_SCHEMAS['ops.member.upsert'].properties).toHaveProperty('expected_revision')
    expect(MCP_METHOD_SCHEMAS['ops.member.suspend'].required).toEqual([
      'external_subject', 'expected_revision', 'reason',
    ])
  })

  it('does not accept sensitive finance transport fields', () => {
    const accepted = Object.keys(MCP_METHOD_SCHEMAS['ops.finance.detail'].properties)
    expect(accepted).not.toEqual(expect.arrayContaining([
      'payment_url',
      'provider_transaction_id',
      'provider_payload_json',
      'idempotency_key',
      'receipt_hash',
      'metadata_json',
      'error_json',
    ]))
  })

  it('keeps the audit center read-only, bounded, and free of raw evidence inputs', () => {
    const auditMethods = ['ops.audit.list', 'ops.audit.platform.list', 'ops.audit.detail', 'ops.audit.export'] as const
    expect(auditMethods.every(method => MCP_METHOD_SCHEMAS[method])).toBe(true)
    expect(MCP_METHOD_SCHEMAS['ops.audit.list'].properties.limit?.pattern).toBe('^(?:[1-9]|[1-9][0-9]|100)$')
    expect(MCP_METHOD_SCHEMAS['ops.audit.detail'].required).toEqual(['source', 'id'])
    expect(Object.keys(MCP_METHOD_SCHEMAS['ops.audit.export'].properties)).not.toEqual(expect.arrayContaining([
      'raw_payload',
      'evidence_json',
      'credentials',
      'payment_url',
      'provider_transaction_id',
    ]))
    expect(Object.keys(MCP_METHOD_SCHEMAS).filter(method => method.startsWith('ops.audit.'))).toEqual(auditMethods)
  })
})
