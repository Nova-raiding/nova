import { readFileSync } from 'node:fs'
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { fetchCreativePointStatement } from './api'
import { aggregatePointUsage } from './App'
import capture from './fixtures/creative-point-statement.capture.json'

/**
 * The fixture below is a verbatim capture of a real server response, not a
 * hand-written stub:
 *
 *   POST /api/mcp  {"jsonrpc":"2.0","method":"creative-points.statement.list",
 *                   "params":{"limit":"100"}}
 *   workspace ws_demo, captured over the merchant session at
 *   http://127.0.0.1:28181/ (Vite proxy → API) on 2026-09-20.
 *
 * The previous fixture in `unread-vs-zero.test.ts` was hand-written in the
 * shape the *client* expected (`points_delta`/`occurred_at`, from the dormant
 * `packages/contracts` declaration) instead of the shape the server actually
 * sends (`pointsDelta`/`createdAt`, the persistence DTO). Every real row was
 * therefore dropped by the client, the panel reported 「合计 0 点」, and the
 * suite stayed green. These assertions pin the capture to the producer so a
 * hand-written fixture cannot silently replace it again.
 */
const repositorySource = readFileSync(
  new URL('../../../packages/persistence/src/creative-point-repository.ts', import.meta.url),
  'utf8',
)
const commercialMcpSource = readFileSync(new URL('../../../apps/api/src/mcp-commercial-handlers.ts', import.meta.url), 'utf8')
const commercialHttpSource = readFileSync(new URL('../../../apps/api/src/http-commercial-routes.ts', import.meta.url), 'utf8')

/** Field names of the producing repository DTO, in declaration order. */
function producerEntryFields(): string[] {
  const start = repositorySource.indexOf('export interface CreativePointStatementEntry {')
  expect(start, 'the producing repository must still declare CreativePointStatementEntry').toBeGreaterThan(-1)
  const body = repositorySource.slice(repositorySource.indexOf('{', start) + 1, repositorySource.indexOf('\n}', start))
  return body.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => line.split(':')[0]!.trim())
}

const entries = (capture as { data: { result: { entries: Array<Record<string, unknown>> } } }).data.result.entries

const envelope = (result: unknown) => new Response(JSON.stringify({
  request_id: 'merchant-studio-test', trace_id: 'merchant-studio-test', workspace_id: 'ws_demo',
  data: { jsonrpc: '2.0', id: 'capture', result }, warnings: [], next_actions: [], error: null,
}), { status: 200, headers: { 'content-type': 'application/json' } })

describe('the statement capture is the shape the server produces', () => {
  it('carries every field of the producing repository DTO, no more and no less', () => {
    const producerFields = producerEntryFields()
    expect(producerFields.length, 'the producer DTO must not collapse to nothing').toBeGreaterThan(6)
    expect(Object.keys(entries[0]!)).toEqual(producerFields)
    expect(entries.length, 'an empty capture cannot prove anything about a shape').toBeGreaterThan(0)
  })

  it('is emitted verbatim by both statement surfaces, so the wire shape is the DTO', () => {
    const mcpStart = commercialMcpSource.indexOf("case 'creative-points.statement.list':")
    expect(mcpStart, 'the MCP statement handler must exist').toBeGreaterThan(-1)
    const mcpCase = commercialMcpSource.slice(mcpStart, commercialMcpSource.indexOf("case 'commercial.catalog.get':", mcpStart))
    expect(mcpCase).toContain('entries: statement.items')
    const httpStart = commercialHttpSource.indexOf("path === '/v1/creative-points/statement'")
    expect(httpStart, 'the HTTP statement handler must exist').toBeGreaterThan(-1)
    const httpCase = commercialHttpSource.slice(httpStart, commercialHttpSource.indexOf("path === '/v1/commercial/catalog'", httpStart))
    expect(httpCase).toContain('creativePoints.listStatement')
  })
})

describe('the merchant client reads the real statement shape', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_TOKEN', 'merchant-api-test-token')
    vi.stubGlobal('window', globalThis)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('parses every field of a real response instead of dropping the rows', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope({ entries, next_cursor: null })))
    const page = await fetchCreativePointStatement('http://127.0.0.1:9')
    expect(page).not.toBeNull()
    expect(page!.entries).toHaveLength(entries.length)
    expect(page!.unreadableEntries).toBe(0)
    // Field-by-field parity between the client's parsed row and the wire row:
    // a rename on either side fails here instead of silently emptying the page.
    expect(Object.keys(page!.entries[0]!)).toEqual(Object.keys(entries[0]!))
    expect(page!.entries[0]).toMatchObject({
      id: entries[0]!.id,
      eventType: entries[0]!.eventType,
      pointsDelta: entries[0]!.pointsDelta,
      createdAt: entries[0]!.createdAt,
    })
  })

  it('treats a response in another shape as unread, not as an empty ledger', async () => {
    // The dormant contracts/legacy shape: rows are present but unreadable.
    const snakeCase = entries.map((entry) => ({
      id: entry.id, event_type: 'consume', points_delta: -1, balance_after: 9, occurred_at: '2026-09-01T00:00:00.000Z',
    }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope({ entries: snakeCase, next_cursor: null })))
    await expect(fetchCreativePointStatement('http://127.0.0.1:9')).resolves.toBeNull()
  })

  it('discloses rows it could not read instead of summing them away', async () => {
    const mixed = [entries[0]!, { id: 'unknown-shape', amount: 'oops' }]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope({ entries: mixed, next_cursor: null })))
    const page = await fetchCreativePointStatement('http://127.0.0.1:9')
    expect(page!.entries).toHaveLength(1)
    expect(page!.unreadableEntries).toBe(1)
  })
})

describe('consumption drawn from the real shape reaches the chart', () => {
  it('buckets a consumption row that the old snake_case reader discarded', () => {
    // Same keys as the capture; only the values describe a consumption event.
    const consumed = { ...entries[0]!, eventType: 'settled', pointsDelta: -1500, createdAt: '2026-09-01T00:00:00.000Z' }
    const usage = aggregatePointUsage([consumed], 'day')
    expect(usage).toEqual([{ label: '09/01', dateLabel: '2026/09/01', value: 1500 }])
    // Grants are still not consumption, but they are no longer the only rows the
    // client can see.
    expect(aggregatePointUsage(entries, 'day')).toEqual([])
  })
})
