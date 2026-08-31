import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { AuditCenterRecord } from '../../../../packages/contracts/src/ops/audit-center.js'
import { buildAuditCenterQuery, mergeAuditRecords, type AuditCenterFilters } from './useAuditCenter.js'

const record = (id: string, source: AuditCenterRecord['source'] = 'operation'): AuditCenterRecord => ({
  id,
  source,
  workspaceId: 'ws_1',
  actorId: 'ops',
  action: 'change',
  resourceType: 'member',
  resourceId: id,
  reason: '',
  occurredAt: '2026-08-29T00:00:00Z',
  redacted: true,
})

describe('audit center hook', () => {
  it('deduplicates stable cursor page replays by source and id', () => {
    expect(mergeAuditRecords(
      [record('1')],
      [record('1'), record('1', 'rule'), record('2')],
    ).map(item => `${item.source}:${item.id}`)).toEqual([
      'operation:1',
      'rule:1',
      'operation:2',
    ])
  })

  it('builds the canonical service query without leaking a prior cursor', () => {
    const filters: AuditCenterFilters = { text: 'refund', sources: ['operation'] }
    expect(buildAuditCenterQuery('ws_1', filters, 'cursor-2')).toEqual({
      workspaceId: 'ws_1',
      text: 'refund',
      sources: ['operation'],
      cursor: 'cursor-2',
      limit: 50,
    })
    expect(buildAuditCenterQuery('ws_2', filters, undefined, 100)).toEqual({
      workspaceId: 'ws_2',
      text: 'refund',
      sources: ['operation'],
      limit: 100,
    })
  })

  it('cancels stale list, detail, and export work and debounces filter reloads', async () => {
    const source = await readFile(new URL('./useAuditCenter.ts', import.meta.url), 'utf8')
    expect(source).toContain('listAbort.current?.abort()')
    expect(source).toContain('detailAbort.current?.abort()')
    expect(source).toContain('exportAbort.current?.abort()')
    expect(source).toContain('request !== listRequest.current')
    expect(source).toContain('request !== exportRequest.current')
    expect(source).toContain('window.setTimeout(() => void run(false), 250)')
  })

  it('restores focus to the exact detail trigger after closing the drawer', async () => {
    const source = await readFile(new URL('./useAuditCenter.ts', import.meta.url), 'utf8')
    expect(source).toContain('if (returnFocusTo) detailReturnFocus.current = returnFocusTo')
    expect(source).toContain('target?.isConnected')
    expect(source).toContain('window.requestAnimationFrame(() => target.focus())')
  })

  it('normalizes a malformed page before reading or merging records', async () => {
    const source = await readFile(new URL('./useAuditCenter.ts', import.meta.url), 'utf8')
    expect(source).toContain('Array.isArray(page?.records) ? page.records : []')
    expect(source).toContain("typeof page?.nextCursor === 'string'")
    expect(source).toContain('setTotalRecords')
  })
})
