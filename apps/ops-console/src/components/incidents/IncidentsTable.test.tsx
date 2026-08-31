import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { IncidentsTable } from './IncidentsTable.js'

describe('IncidentsTable', () => {
  it('renders semantic severity, status and accessible detail action', () => {
    const html = renderToStaticMarkup(<IncidentsTable loading={false} onSelect={() => undefined} incidents={[{ id: 'incident_1', workspaceId: 'ws_1', title: '支付不可用', summary: '支付请求失败', severity: 'sev1', status: 'investigating', affectedComponents: ['payment'], affectedWorkspaceIds: ['ws_1'], revision: 1, createdBy: 'ops_1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }]} />)
    expect(html).toContain('严重度：SEV-1 严重')
    expect(html).toContain('状态：调查中')
    expect(html).toContain('查看事故：支付不可用')
    expect(html).toContain('min-height:44px')
  })
})
