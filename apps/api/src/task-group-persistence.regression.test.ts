import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const routeSource = readFileSync(new URL('./http-task-routes.ts', import.meta.url), 'utf8')
const mcpSource = readFileSync(new URL('./mcp-task-write-handlers.ts', import.meta.url), 'utf8')
const serverSource = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
const persistenceSource = readFileSync(new URL('./task-group-persistence.ts', import.meta.url), 'utf8')
const serviceSource = readFileSync(new URL('../../../packages/application/src/service.ts', import.meta.url), 'utf8')
const outboxMigration = readFileSync(new URL('../../../packages/persistence/src/migrations/001_initial.sql', import.meta.url), 'utf8')

describe('task group persistence contract', () => {
  it('routes all group creation paths through grouped persistence on both first request and replay', () => {
    expect(routeSource.match(/await persistGroup\(/gu)).toHaveLength(5)
    expect(routeSource).not.toMatch(/if \(!(?:group|created|split)\.replayed\)/u)
    expect(routeSource).toContain("eventType: 'task.created'")
    expect(routeSource).toContain("eventType: 'task.sku_split'")
  })

  it('commits every group snapshot and per-task event in one workspace transaction', () => {
    expect(serverSource).toContain('return persistTaskGroupTransaction({')
    expect(persistenceSource).toContain('withWorkspaceTransaction(input.pool, input.workspaceId')
    expect(persistenceSource).toContain('input.saveSnapshot(client, snapshot)')
    expect(persistenceSource).toContain('input.appendEvent(client,')
    expect(persistenceSource).toContain('if (saved.entityVersion < snapshot.entityVersion)')
    expect(persistenceSource).toContain('const payload = durable ? { ...event.payload, ...durable } : event.payload')
    expect(persistenceSource).toContain("event.eventType === 'task.created'")
    expect(persistenceSource).toContain("event.eventType === 'task.sku_split'")
    expect(persistenceSource).toContain("event_type='task.created' LIMIT 1")
    expect(persistenceSource).toContain("payload->>'task_group_id'=$3 LIMIT 1")
    expect(persistenceSource.indexOf('for (const snapshot of input.snapshots)')).toBeLessThan(persistenceSource.indexOf('for (const event of input.events)'))
    expect(serverSource).toContain("if (isProduction()) throw new DomainError('TASK_GROUP_PERSISTENCE_UNAVAILABLE'")
  })

  it('keeps worker-consumed task.created events and their original per-task aggregate sequence', () => {
    expect(routeSource).toContain("eventType: 'task.created', sequence: task.version")
    expect(routeSource).toContain('aggregateId: task.id')
    expect(routeSource).toContain('payload: { ...task, task_group_id: group.id }')
  })

  it('routes MCP group, request, and SKU split writes through grouped persistence on replay too', () => {
    expect(mcpSource.match(/await persistGroup\(/gu)).toHaveLength(5)
    expect(mcpSource).not.toMatch(/if \(!(?:created|split|group)\.replayed\)/u)
    expect(mcpSource).toContain("eventType: 'task.created', sequence: task.version")
    expect(mcpSource).toContain("eventType: 'task.sku_split', sequence: source.version")
  })

  it('allocates a unique source event sequence per split group and reuses it on replay', () => {
    const split = serviceSource.slice(serviceSource.indexOf('splitTaskBySku(input:'), serviceSource.indexOf('understandTaskRequest(workspaceId:'))
    expect(split).toContain('...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})')
    expect(persistenceSource).toContain("payload->>'task_group_id'=$3")
    expect(persistenceSource).toContain('pg_advisory_xact_lock(hashtext($1))')
    expect(persistenceSource).toContain('COALESCE(MAX(sequence),0)+1 AS sequence')
    expect(persistenceSource).toContain('sequence: nextSequence.rows[0]!.sequence')
    expect(outboxMigration).toContain('UNIQUE (workspace_id, aggregate_id, event_type, sequence)')
  })
})
