import { describe, expect, it } from 'vitest'
import { PostgresBusinessRepository } from './business-repository.js'
import { type SqlClient, type SqlPool } from './repository.js'

type Row = Record<string, unknown>
class RecordingClient implements SqlClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []
  private readonly responses: Array<{ rows: Row[] }> = []
  enqueue(...rows: Row[]) { this.responses.push({ rows }) }
  async query<T = Row>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values })
    return (this.responses.shift() ?? { rows: [] }) as { rows: T[] }
  }
  release() {}
}
class RecordingPool implements SqlPool {
  constructor(readonly client: RecordingClient) {}
  async connect() { return this.client }
}

function repositoryFor(table: 'products' | 'tasks') {
  const client = new RecordingClient()
  client.enqueue() // BEGIN
  client.enqueue() // tenant scope
  client.enqueue({ total: '1' })
  client.enqueue({ data: { id: table === 'products' ? 'prod_filter' : 'task_filter' } })
  client.enqueue() // COMMIT
  return { client, repository: new PostgresBusinessRepository(new RecordingPool(client)) }
}

describe('durable catalog filter parity', () => {
  it.each(['products', 'tasks'] as const)('ignores whitespace-only %s query filters', async table => {
    const { client, repository } = repositoryFor(table)
    if (table === 'products') await repository.listProductsPage('ws_filter', { limit: 10, offset: 0, query: '   ' })
    else await repository.listTasksPage('ws_filter', { limit: 10, offset: 0, query: '   ' })

    expect(client.calls[2]?.values).toEqual(['ws_filter'])
    expect(client.calls[3]?.values).toEqual(['ws_filter', 10, 0])
    expect(client.calls[2]?.text).not.toContain("LIKE '%' || lower(")
  })

  it.each([
    ['products', 'storeName'], ['products', 'brandName'],
    ['tasks', 'storeName'], ['tasks', 'brandName'],
  ] as const)('ignores whitespace-only %s %s filters', async (table, filter) => {
    const { client, repository } = repositoryFor(table)
    if (table === 'products') await repository.listProductsPage('ws_filter', { limit: 10, offset: 0, [filter]: '   ' })
    else await repository.listTasksPage('ws_filter', { limit: 10, offset: 0, [filter]: '   ' })

    expect(client.calls[2]?.values).toEqual(['ws_filter'])
    expect(client.calls[3]?.values).toEqual(['ws_filter', 10, 0])
    expect(client.calls[2]?.text).not.toContain("LIKE '%' || lower(")
  })

  it.each(['products', 'tasks'] as const)('matches %s against the canonical workspace brand profile', async table => {
    const { client, repository } = repositoryFor(table)
    if (table === 'products') await repository.listProductsPage('ws_filter', { limit: 10, offset: 0, brandName: '云朵' })
    else await repository.listTasksPage('ws_filter', { limit: 10, offset: 0, brandName: '云朵' })

    expect(client.calls[2]?.text).toContain("brand_profile.entity_type = 'brand_profile'")
    expect(client.calls[2]?.text).toContain("brand_profile.entity_id = 'brand_' || products.workspace_id")
    expect(client.calls[2]?.text).toContain("brand_profile.payload->>'name'")
    expect(client.calls[2]?.values).toEqual(['ws_filter', '云朵', '云朵'])
    expect(client.calls[3]?.values).toEqual(['ws_filter', '云朵', '云朵', 10, 0])
  })
})
