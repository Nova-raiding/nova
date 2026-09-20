import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'
import type { SqlClient, SqlPool } from './repository.js'
import {
  PostgresSupportRepository,
  type SupportTicketListInput,
  type SupportTicketPage,
  type SupportTicketPageCursor,
} from './support-repository.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

/**
 * Statements one `list()` call may issue when an SLA-state filter cannot be
 * pushed into SQL. The scan is bounded to `SLA_FILTER_SCAN_MAX_BATCHES` keyset
 * batches, each of which costs one ticket page read plus one batched event
 * read, on top of BEGIN / set_config / COMMIT.
 *
 * The pre-fix implementation had no bound at all: it kept pulling 200-row
 * batches until it filled the page or emptied the table, so the cost grew with
 * the workspace size. This fixture holds 5,000 tickets; the pre-fix code issued
 * 53 statements (25 batches, 5,000 rows scanned) for a single `list()` call,
 * and a 100,000-ticket workspace would have issued 1,003.
 */
const SLA_SCAN_MAX_BATCHES = 10
const SLA_SCAN_BATCH_ROWS = 200
const SLA_SCAN_STATEMENT_BUDGET = 3 + 2 * SLA_SCAN_MAX_BATCHES
const SLA_SCAN_ROW_BUDGET = SLA_SCAN_BATCH_ROWS * SLA_SCAN_MAX_BATCHES

const workspaceId = 'ws_sla_scan'
const fillerCount = 5_000
/** Newest ticket, inside the first scan window. Its frozen snapshot says on_track. */
const metTopId = '11111111-1111-4111-8111-111111111111'
/** Second newest, inside the first scan window. Its frozen snapshot says at_risk. */
const breachedId = '22222222-2222-4222-8222-222222222222'
/** Oldest ticket, outside any single bounded window. Found only by following nextCursor. */
const metDeepId = '33333333-3333-4333-8333-333333333333'

/** Records every statement so a test can assert on the scan's shape, not just its result. */
class CountingPool implements SqlPool {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = []
  constructor(private readonly inner: SqlPool) {}
  async connect(): Promise<SqlClient> {
    const client = await this.inner.connect()
    return {
      query: async <Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
        this.calls.push({ text, values: values ?? [] })
        return client.query<Row>(text, values as unknown[])
      },
      release: (error?: Error) => { client.release?.(error) },
    }
  }
  reset() { this.calls.length = 0 }
  get scan() {
    const ticketPages = this.calls.filter(call => call.text.includes('FROM workspace_support_tickets'))
    const eventPages = this.calls.filter(call => call.text.includes('FROM workspace_support_ticket_events'))
    const batch = Number(ticketPages.at(-1)?.values.at(-1) ?? 0)
    return { statements: this.calls.length, batches: ticketPages.length, eventPages: eventPages.length, scannedRows: ticketPages.length * batch }
  }
}

const snapshotJson = (state: 'on_track' | 'at_risk', firstResponseDueAt: string, resolutionDueAt: string) => JSON.stringify({
  policy: { version: 1, calendar: 'business_weekday_utc', firstResponseMinutes: 480, resolutionMinutes: 2880 },
  firstResponseDueAt,
  resolutionDueAt,
  pausedMinutes: 0,
  state,
})

describe('support ticket SLA-state filter PostgreSQL acceptance', () => {
  const databaseName = `support_sla_scan_${randomUUID().replaceAll('-', '')}`
  const isoFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()
  let admin: Pool | undefined
  let database: Pool | undefined
  let counting: CountingPool | undefined
  let repository: PostgresSupportRepository | undefined
  let primaryFailure: unknown

  beforeAll(async () => {
    if (!databaseUrlValue) return
    const base = new URL(databaseUrlValue)
    admin = new Pool({ connectionString: base.toString(), max: 3 })
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const isolated = new URL(base)
      isolated.pathname = `/${databaseName}`
      database = new Pool({ connectionString: isolated.toString(), max: 3 })
      await new MigrationRunner(database, await loadMigrations()).run()
      await database.query(`INSERT INTO workspaces (id, status) VALUES ($1, 'active')`, [workspaceId])
      // Fillers: every one lands on_track from its frozen snapshot, so a
      // projection that quietly fell back to the snapshot would still be
      // "correct" for them and only visibly wrong for the three special rows.
      await database.query(`INSERT INTO workspace_support_tickets
        (id, workspace_id, ticket_number, subject, description, status, priority, customer_id, customer_name,
         tags, revision, create_idempotency_key, created_by, created_at, updated_at, sla_snapshot_json)
        SELECT ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, $1, 'SUP-BULK-' || i,
          '批量工单 ' || i, '批量工单描述文本', 'open', 'normal', 'customer_bulk', '批量客户', ARRAY[]::text[], 1,
          'bulk-key-' || lpad(i::text, 8, '0'), 'support_seed',
          now() - interval '400 days' + make_interval(mins => i),
          now() - interval '400 days' + make_interval(mins => i), $2::jsonb
        FROM generate_series(1, $3::int) AS i`,
      [workspaceId, snapshotJson('on_track', isoFromNow(300), isoFromNow(320)), fillerCount])

      const insertTicket = async (id: string, ticketNumber: string, createdAt: string, snapshot: string) => {
        await database!.query(`INSERT INTO workspace_support_tickets
          (id, workspace_id, ticket_number, subject, description, status, priority, customer_id, customer_name,
           tags, revision, create_idempotency_key, created_by, created_at, updated_at, sla_snapshot_json)
          VALUES ($1,$2,$3,$4,'特殊工单描述文本','open','normal','customer_special','特殊客户',ARRAY[]::text[],1,$5,'support_seed',$6,$6,$7::jsonb)`,
        [id, workspaceId, ticketNumber, `特殊工单 ${ticketNumber}`, `special-key-${ticketNumber}`, createdAt, snapshot])
      }
      const insertEvent = async (ticketId: string, sequence: number, eventType: string, createdAt: string, payload: Record<string, unknown>) => {
        await database!.query(`INSERT INTO workspace_support_ticket_events
          (id, workspace_id, ticket_id, sequence, event_type, actor_id, idempotency_key, payload_json, created_at)
          VALUES ($1,$2,$3,$4,$5,'support_seed',$6,$7::jsonb,$8)`,
        [randomUUID(), workspaceId, ticketId, sequence, eventType, `event-key-${ticketId}-${sequence}`, JSON.stringify(payload), createdAt])
      }

      // Resolved by its event stream only: the immutable snapshot (migration 112)
      // was frozen at creation and can only ever hold on_track/at_risk.
      const onTrack = snapshotJson('on_track', isoFromNow(300), isoFromNow(320))
      await insertTicket(metTopId, 'SUP-MET-TOP', isoFromNow(-395), onTrack)
      await insertEvent(metTopId, 1, 'created', isoFromNow(-395), { status: 'open', priority: 'normal' })
      await insertEvent(metTopId, 2, 'status_changed', isoFromNow(-394), { from: 'open', to: 'resolved', reason: '客户确认已解决' })

      await insertTicket(metDeepId, 'SUP-MET-DEEP', isoFromNow(-401), onTrack)
      await insertEvent(metDeepId, 1, 'created', isoFromNow(-401), { status: 'open', priority: 'normal' })
      await insertEvent(metDeepId, 2, 'status_changed', isoFromNow(-400), { from: 'open', to: 'resolved', reason: '客户确认已解决' })

      // Overdue resolution with no resolving event: the projection is breached
      // while the row's own snapshot still reports at_risk.
      await insertTicket(breachedId, 'SUP-BREACHED', isoFromNow(-396), snapshotJson('at_risk', isoFromNow(-40), isoFromNow(-30)))
      await insertEvent(breachedId, 1, 'created', isoFromNow(-396), { status: 'open', priority: 'normal' })

      counting = new CountingPool(database)
      repository = new PostgresSupportRepository(counting)
    } catch (error) {
      primaryFailure = error
      throw error
    }
  }, 60_000)

  afterAll(async () => {
    if (!admin) return
    await withPostgresFixtureCleanup(async () => {
      await database?.end()
      await dropDrainedPostgresFixture(admin!, databaseName)
    }, primaryFailure, [() => admin!.end()])
  })

  const listSla = async (slaState: NonNullable<SupportTicketListInput['slaState']>, cursor?: SupportTicketPageCursor, limit = 20): Promise<SupportTicketPage> => {
    counting!.reset()
    return repository!.list({ workspaceId, slaState, ...(cursor ? { cursor } : {}), limit })
  }

  postgresIt('keeps the SLA filter on the projected state and bounds how far it scans', async () => {
    const page = await listSla('met')
    const stats = counting!.scan

    // Boundedness: the scan stops at the cap instead of walking all 5,000 rows.
    expect(stats.batches).toBeLessThanOrEqual(SLA_SCAN_MAX_BATCHES)
    expect(stats.eventPages).toBe(stats.batches)
    expect(stats.scannedRows).toBeGreaterThan(0)
    expect(stats.scannedRows, `scanned ${stats.scannedRows} rows in ${stats.statements} statements`).toBeLessThanOrEqual(SLA_SCAN_ROW_BUDGET)
    expect(stats.statements, `issued ${stats.statements} statements`).toBeLessThanOrEqual(SLA_SCAN_STATEMENT_BUDGET)

    // A truncated page is still a usable page: it says so and it hands back a cursor.
    expect(page.items.length).toBeLessThanOrEqual(20)
    expect(page.scanTruncated).toBe(true)
    expect(page.nextCursor).toBeDefined()

    // Semantics: the state comes from the event stream, not the frozen snapshot.
    expect(page.items.map(ticket => ticket.id)).toEqual([metTopId])
    expect(page.items[0]!.sla.state).toBe('met')
    expect(page.items[0]!.sla.resolvedAt).toBeDefined()
  }, 30_000)

  postgresIt('resumes the bounded scan from nextCursor and finds the match beyond the window', async () => {
    const seen = new Set<string>()
    let cursor: SupportTicketPageCursor | undefined
    let pages = 0
    let truncatedPages = 0
    let terminalPage: SupportTicketPage | undefined
    while (pages < 10) {
      const page = await listSla('met', cursor)
      pages += 1
      for (const ticket of page.items) seen.add(ticket.id)
      expect(counting!.scan.statements, `page ${pages} issued ${counting!.scan.statements} statements`).toBeLessThanOrEqual(SLA_SCAN_STATEMENT_BUDGET)
      if (page.scanTruncated) truncatedPages += 1
      if (!page.nextCursor) { terminalPage = page; break }
      cursor = page.nextCursor
    }

    // Both matches are reached, exactly once each: the continuation cursor
    // neither skips the rows a bounded scan stopped short of nor repeats them.
    expect([...seen].sort()).toEqual([metTopId, metDeepId].sort())
    expect(truncatedPages).toBeGreaterThan(0)
    expect(terminalPage, 'the walk must reach a real end, not stop at the page budget').toBeDefined()
    expect(terminalPage!.scanTruncated).toBeFalsy()
    expect(terminalPage!.nextCursor).toBeUndefined()
  }, 30_000)

  postgresIt('leaves the unfiltered page on its single-batch fast path', async () => {
    counting!.reset()
    const page = await repository!.list({ workspaceId, limit: 20 })
    const stats = counting!.scan

    // No SLA filter means no projection filter, so the bound is irrelevant: the
    // page arrives from one keyset read and is never marked as truncated.
    expect(stats.batches).toBe(1)
    expect(stats.statements).toBeLessThanOrEqual(6)
    expect(page.items).toHaveLength(20)
    expect(page.scanTruncated).toBeUndefined()
    expect(page.nextCursor).toBeDefined()
  }, 30_000)

  postgresIt('never classifies a ticket by its frozen snapshot', async () => {
    const breached = await listSla('breached')
    expect(breached.items.map(ticket => ticket.id)).toEqual([breachedId])
    expect(breached.items[0]!.sla.state).toBe('breached')

    const onTrack = await listSla('on_track')
    expect(onTrack.items).toHaveLength(20)
    expect(onTrack.items.every(ticket => ticket.sla.state === 'on_track')).toBe(true)
    for (const ticket of onTrack.items) {
      expect([metTopId, metDeepId, breachedId]).not.toContain(ticket.id)
    }

    // The unfiltered-by-truncation path (a full page inside the first batch)
    // keeps the pre-existing keyset contract: the cursor sits on the last
    // returned row and the next batch neither repeats nor skips it.
    expect(onTrack.scanTruncated).toBeFalsy()
    const next = await listSla('on_track', onTrack.nextCursor)
    const returnedIds = new Set(onTrack.items.map(ticket => ticket.id))
    expect(next.items).toHaveLength(20)
    expect(next.items.some(ticket => returnedIds.has(ticket.id))).toBe(false)
  }, 30_000)
})
