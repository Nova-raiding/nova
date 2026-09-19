import { describe, expect, it, vi } from 'vitest'
import { MemoryAuditCenterRepository } from '../../../packages/persistence/src/audit-center-repository.js'
import type { FinanceSearchRepository } from '../../../packages/persistence/src/finance-search-repository.js'
import { AuditCenterService } from './ops/audit-center-service.js'
import { csvCell as sharedCsvCell } from './ops/csv-cell.js'
import { FinanceSearchService } from './ops/finance-search-service.js'
import { csvCell } from './server.js'

/**
 * Spreadsheet formula injection is a property of the *export*, not of one
 * service, so these tests cover all three CSV surfaces that ship to a user:
 * `server.ts` (ops users / ops commercial / billing exports), the finance
 * search export and the audit center export.
 *
 * Before the convergence fix, `server.ts` checked only `/^[=+\-@]/` while the
 * two `ops/` services checked `/^[=+@\-\t\r]/`, so a tab- or CR-prefixed cell
 * was neutralized by two of the three. The six-input table below is red for
 * `\t=cmd` and `\r=cmd` against the old `server.ts` implementation.
 */
const FORMULA_INPUTS = ['=cmd', '+cmd', '-cmd', '@cmd', '\t=cmd', '\r=cmd'] as const

const isNeutralized = (encoded: string) => encoded.startsWith(`"'`)

describe('CSV formula-injection escaping', () => {
  it.each(FORMULA_INPUTS)('neutralizes a cell starting with %j', input => {
    expect(isNeutralized(csvCell(input))).toBe(true)
  })

  it('still quotes and doubles embedded quotes so a value cannot break out of its field', () => {
    expect(csvCell('normal, text')).toBe('"normal, text"')
    expect(csvCell('=HYPERLINK("https://evil.example")')).toBe(`"'=HYPERLINK(""https://evil.example"")"`)
    expect(csvCell('a"b=c')).toBe('"a""b=c"')
    expect(csvCell(undefined)).toBe('""')
  })

  it('is one implementation shared by every export, not a per-service copy', () => {
    // Identity, not just equal behaviour: three hand-copied encoders are what
    // let the tab/CR gap open in the first place.
    expect(csvCell).toBe(sharedCsvCell)
  })

  it('neutralizes tab- and CR-prefixed cells in the finance search export', async () => {
    const record = {
      id: '\t=cmd', kind: 'recharge_order' as const, workspaceId: 'ws_a', status: 'paid', label: '充值订单',
      reference: '\r=cmd', amountCny: 10, occurredAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:00.000Z',
      version: 'v1', redacted: true as const,
    }
    const repository: FinanceSearchRepository = {
      search: vi.fn(),
      detail: vi.fn(),
      exportRows: vi.fn(async () => ({ records: [record], snapshotAt: '2026-08-29T00:00:00.000Z', truncated: false })),
    } as unknown as FinanceSearchRepository
    const exported = await new FinanceSearchService(repository, () => new Date('2026-08-29T00:00:00.000Z'))
      .exportCsv({ actorId: 'finance_1', roles: ['finance'], authorizedWorkspaceIds: ['ws_a'] }, { kinds: ['recharge_order'] })
    expect(exported.csv).toContain(`"'\t=cmd"`)
    expect(exported.csv).toContain(`"'\r=cmd"`)
  })

  it('neutralizes tab- and CR-prefixed cells in the audit center export', async () => {
    const event = {
      id: 'event_1', source: 'operation' as const, workspace_id: 'ws_1', actor_id: '\t=cmd', action: 'member.update',
      resource_type: 'member', resource_id: '\r=cmd', reason: 'ok', occurred_at: '2026-08-29T00:00:00Z', evidence: {},
    }
    const exported = await new AuditCenterService(new MemoryAuditCenterRepository([event]), () => new Date('2026-08-29T01:00:00Z'))
      .exportCsv({ actorId: 'ops_1', roles: ['platform_ops'], authorizedWorkspaceIds: [], platformWide: true }, { workspaceId: 'ws_1', limit: 50 })
    expect(exported.csv).toContain(`"'\t=cmd"`)
    expect(exported.csv).toContain(`"'\r=cmd"`)
  })
})
