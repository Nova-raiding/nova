import { describe, expect, it } from 'vitest'
import { MemorySupportRepository, SupportTicketNotFoundError } from '../../../../packages/persistence/src/support-repository.js'
import {
  SupportAuthorizationError,
  SupportService,
  SupportValidationError,
  type SupportAuthorizationContext,
} from './support-service.js'

const supportContext: SupportAuthorizationContext = {
  actorId: 'support_1', role: 'support', workspaceId: 'ws_1',
  permissions: ['support.ticket.read', 'support.ticket.create', 'support.ticket.assign', 'support.ticket.transition', 'support.ticket.comment'],
}
const platformContext: SupportAuthorizationContext = {
  actorId: 'ops_1', role: 'platform_ops', workspaceId: 'ws_1',
  permissions: ['support.ticket.read', 'support.ticket.create', 'support.ticket.assign', 'support.ticket.transition', 'support.ticket.comment', 'support.crm.export'],
}

async function seed(service: SupportService) {
  return service.create(supportContext, {
    workspaceId: 'ws_1', subject: '店铺授权失败', description: '客户无法完成平台 OAuth 授权。', priority: 'high',
    customerId: 'customer_1', customerName: '云朵商家', customerEmail: 'OWNER@EXAMPLE.TEST', tags: ['OAuth'],
    idempotencyKey: 'create-ticket-001',
  })
}

describe('SupportService', () => {
  it('requires an explicitly tenant-bound permission context', async () => {
    const service = new SupportService(new MemorySupportRepository())
    await expect(service.list({ ...supportContext, workspaceId: 'ws_2' }, { workspaceId: 'ws_1' })).rejects.toBeInstanceOf(SupportAuthorizationError)
    await expect(service.list({ ...supportContext, permissions: [] }, { workspaceId: 'ws_1' })).rejects.toBeInstanceOf(SupportAuthorizationError)
  })

  it('validates and normalizes ticket input', async () => {
    const service = new SupportService(new MemorySupportRepository())
    const created = await seed(service)
    expect(created.ticket).toMatchObject({ customerEmail: 'owner@example.test', tags: ['oauth'] })
    await expect(service.create(supportContext, {
      workspaceId: 'ws_1', subject: 'x', description: '问题', priority: 'high', customerId: 'c', customerName: 'n', idempotencyKey: 'create-ticket-002',
    })).rejects.toBeInstanceOf(SupportValidationError)
    await expect(service.list(supportContext, {
      workspaceId: 'ws_1', cursor: { createdAt: 'not-a-date', id: 'not-a-uuid' }, limit: 25,
    })).rejects.toMatchObject({ code: 'SUPPORT_VALIDATION_FAILED', field: 'cursor' })
    await expect(service.list(supportContext, {
      workspaceId: 'ws_1', assigneeId: 'x'.repeat(257), limit: 25,
    })).rejects.toMatchObject({ code: 'SUPPORT_VALIDATION_FAILED', field: 'assigneeId' })
  })

  it('reports a missing ticket as a real not-found error', async () => {
    const service = new SupportService(new MemorySupportRepository())
    await expect(service.get(supportContext, 'ws_1', '00000000-0000-4000-8000-000000000001')).rejects.toBeInstanceOf(SupportTicketNotFoundError)
  })

  it('enforces the status state machine and optimistic revision', async () => {
    const service = new SupportService(new MemorySupportRepository())
    const created = await seed(service)
    await expect(service.transition(supportContext, {
      workspaceId: 'ws_1', ticketId: created.ticket.id, status: 'resolved', reason: '直接结束', expectedRevision: 1, idempotencyKey: 'transition-ticket-001',
    })).rejects.toMatchObject({ code: 'SUPPORT_VALIDATION_FAILED', field: 'status' })

    const active = await service.transition(supportContext, {
      workspaceId: 'ws_1', ticketId: created.ticket.id, status: 'in_progress', reason: '开始排查', expectedRevision: 1, idempotencyKey: 'transition-ticket-002',
    })
    expect(active.ticket).toMatchObject({ status: 'in_progress', revision: 2 })
    const replay = await service.transition(supportContext, {
      workspaceId: 'ws_1', ticketId: created.ticket.id, status: 'in_progress', reason: '开始排查', expectedRevision: 1, idempotencyKey: 'transition-ticket-002',
    })
    expect(replay.replayed).toBe(true)
  })

  it('keeps CRM export restricted to platform operations and returns a read projection', async () => {
    const service = new SupportService(new MemorySupportRepository(), () => new Date('2026-08-29T00:00:00.000Z'))
    await seed(service)
    await expect(service.exportCrm({ ...supportContext, permissions: [...supportContext.permissions, 'support.crm.export'] }, 'ws_1')).rejects.toBeInstanceOf(SupportAuthorizationError)

    const exported = await service.exportCrm(platformContext, 'ws_1')
    expect(exported).toMatchObject({ generatedAt: '2026-08-29T00:00:00.000Z', workspaceId: 'ws_1', rows: [{ customerId: 'customer_1', totalTickets: 1 }] })
    expect(exported.columns).toContain('last_ticket_status')
  })
})
