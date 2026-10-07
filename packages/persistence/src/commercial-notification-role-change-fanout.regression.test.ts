import { describe, expect, it } from 'vitest'
import { PostgresCommercialNotificationRepository, type CommercialNotificationAuthorizer } from './commercial-notification-repository.js'
import type { SqlClient, SqlPool, SqlQueryResult } from './repository.js'

/** A tiny SQL-port fixture that preserves the repository's lease/cursor and
 * insert boundary while allowing membership roles to change between batches. */
class NotificationFanoutFixture implements SqlPool {
  readonly event = {
    event_id: 'event-role-change', sku_code: 'private-sku', version: 1,
    visibility: 'private' as const, payload: {}, created_at: '2026-10-07T00:00:00.000Z',
    cursor_member_id: '', audience_workspace_id: null, completed_at: null as string | null,
    lease_token: null as string | null,
  }
  readonly members = [
    { id: 'member-a', workspace_id: 'ws-role-change', identity_id: null, role: 'merchant_admin', status: 'active' },
    { id: 'member-b', workspace_id: 'ws-role-change', identity_id: null, role: 'merchant_admin', status: 'active' },
  ]
  readonly notifications: string[] = []

  async connect(): Promise<SqlClient> {
    return {
      query: async <Row = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> => {
        let rows: unknown[] = []
        let rowCount = 0
        if (text.includes('UPDATE commercial_catalog_publish_outbox SET lease_token')) {
          if (!this.event.completed_at && !this.event.lease_token) {
            this.event.lease_token = String(values[0])
            rows = [{ event_id: this.event.event_id }]
            rowCount = 1
          }
        } else if (text.includes('SELECT * FROM commercial_catalog_publish_outbox WHERE event_id=$1')) {
          if (values[0] === this.event.event_id && values[1] === this.event.lease_token) rows = [this.event]
        } else if (text.includes('FROM workspace_members m LEFT JOIN platform_identities')) {
          const cursor = String(values[0])
          const limit = Number(values[3])
          rows = this.members
            .filter(member => member.id > cursor && member.status === 'active')
            .sort((a, b) => a.id.localeCompare(b.id))
            .slice(0, limit)
            .map(({ id, workspace_id, identity_id, role }) => ({ id, workspace_id, identity_id, role }))
        } else if (text.includes('INSERT INTO workspace_commercial_notifications')) {
          const memberId = String(values[1])
          const member = this.members.find(candidate => candidate.id === memberId && candidate.workspace_id === values[0] && candidate.status === 'active')
          if (member && !this.notifications.includes(memberId)) {
            this.notifications.push(memberId)
            rowCount = 1
          }
        } else if (text.includes('UPDATE commercial_catalog_publish_outbox SET cursor_member_id')) {
          this.event.cursor_member_id = String(values[2])
          if (values[3] === true) this.event.completed_at = 'done'
          this.event.lease_token = null
        }
        return { rows: rows as Row[], rowCount }
      },
    }
  }
}

describe('commercial notification fanout rechecks current member role between leased batches', () => {
  it('does not deliver the next page after a member loses its authorized role', async () => {
    const fixture = new NotificationFanoutFixture()
    const authorize: CommercialNotificationAuthorizer = recipient => recipient.role === 'merchant_admin'
    const repository = new PostgresCommercialNotificationRepository(fixture, authorize)

    const firstLease = await repository.claim()
    expect(firstLease).toBeDefined()
    expect(await repository.fanout(firstLease!, 1)).toEqual({ scanned: 1, delivered: 1, complete: false })

    fixture.members[1]!.role = 'suspended_role'

    const nextLease = await repository.claim()
    expect(nextLease).toBeDefined()
    expect(await repository.fanout(nextLease!, 1)).toEqual({ scanned: 1, delivered: 0, complete: false })

    const finalLease = await repository.claim()
    expect(finalLease).toBeDefined()
    expect(await repository.fanout(finalLease!, 1)).toEqual({ scanned: 0, delivered: 0, complete: true })
    expect(fixture.notifications).toEqual(['member-a'])
  })
})
