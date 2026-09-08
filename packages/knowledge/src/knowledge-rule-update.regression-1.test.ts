import { describe, expect, it } from 'vitest'
import { KnowledgeError, KnowledgeModule } from './index.js'

const source = { kind: 'official' as const, reference: 'https://rules.example.test/current', checkedAt: '2026-09-08T00:00:00.000Z' }

describe('knowledge rule durable updates', () => {
  // Regression: ISSUE-001 — rule status updates were not revision-safe or replayed after restart
  // Found by /qa on 2026-09-08
  // Report: .gstack/qa-reports/qa-report-127-0-0-1-2026-09-08.md
  it('rejects stale updates and restores the latest rule revision from events', () => {
    let tick = 0
    const original = new KnowledgeModule({
      clock: () => `2026-09-08T00:00:0${tick++}.000Z`,
      idFactory: (prefix, sequence) => `${prefix}-${sequence}`,
    })
    const created = original.createRule({ workspaceId: 'ws-rules', name: '平台标题规则', content: '标题必须可验证', scope: 'global', source, version: '1', status: 'draft' })
    const updated = original.updateRule(created.id, { status: 'active', expectedRevision: created.revision })

    expect(updated).toMatchObject({ id: created.id, status: 'active', revision: 2 })
    expect(() => original.updateRule(created.id, { status: 'inactive', expectedRevision: 1 }))
      .toThrowError(new KnowledgeError('VERSION_CONFLICT'))
    expect(original.getRule(created.id)).toEqual(updated)

    const restored = new KnowledgeModule()
    restored.hydrate([
      { aggregateId: created.id, sequence: created.revision, eventType: 'knowledge.rule.created', payload: created as unknown as Record<string, unknown> },
      { aggregateId: updated.id, sequence: updated.revision, eventType: 'knowledge.rule.updated', payload: updated as unknown as Record<string, unknown> },
    ])
    expect(restored.getRule(created.id)).toEqual(updated)
  })
})
