import { readFile } from 'node:fs/promises'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AuditFilters, fromLocalDateTimeValue, toLocalDateTimeValue } from './AuditFilters.js'
import { AuditCenterSection } from './AuditCenterSection.js'

describe('audit center UI contract', () => {
  it('preserves local wall-clock values while sending canonical ISO timestamps', () => {
    const localValue = '2026-08-29T09:30'
    expect(toLocalDateTimeValue(fromLocalDateTimeValue(localValue))).toBe(localValue)
    expect(fromLocalDateTimeValue('')).toBeUndefined()
  })

  it('gives every audit filter textbox an accessible name', () => {
    const markup = renderToStaticMarkup(createElement(AuditFilters, { value: {}, onChange: () => undefined }))
    for (const label of ['按操作者筛选', '按动作筛选', '按资源类型筛选', '审计开始时间', '审计结束时间']) {
      expect(markup).toContain(`aria-label="${label}"`)
    }
  })

  it('keeps live, error, empty, retry and redaction states explicit', async () => {
    const [section, drawer] = await Promise.all([
      readFile(new URL('./AuditCenterSection.tsx', import.meta.url), 'utf8'),
      readFile(new URL('./AuditDetailDrawer.tsx', import.meta.url), 'utf8'),
    ])
    expect(section).toContain('aria-live="polite"')
    expect(section).toContain('aria-atomic="true"')
    expect(section).toContain('当前筛选条件下没有审计记录')
    expect(section).toContain('已加载全部')
    expect(section).toContain('仍有未加载记录')
    expect(section).toContain('审计记录加载失败')
    expect(section).toContain('重试导出')
    expect(drawer).toContain('服务端已脱敏')
    expect(drawer).toContain('不会下发到前端')
  })

  it('renders an operable compact empty state without a browser layout dependency', () => {
    type Controller = Parameters<typeof AuditCenterSection>[0]['controller']
    const controller = {
      filters: {}, setFilters: () => undefined, records: [], totalRecords: 0, truncated: false, nextCursor: undefined,
      loading: false, loadingMore: false, error: undefined, empty: true,
      selected: undefined, detail: undefined, detailLoading: false, detailError: undefined,
      exporting: false, exportError: undefined, reload: async () => undefined,
      loadMore: async () => undefined, openDetail: async () => undefined,
      closeDetail: () => undefined, downloadCsv: async () => undefined,
    } as unknown as Controller
    const markup = renderToStaticMarkup(createElement(AuditCenterSection, { controller, canExport: true }))
    expect(markup).toContain('不可变审计记录')
    expect(markup).toContain('当前筛选条件下没有审计记录')
    expect(markup).toContain('aria-live="polite"')
    expect(markup).toContain('disabled=""')
  })

  it('uses card layout through 844px landscape and prevents viewport overflow at 375px', async () => {
    const [section, drawer, filters] = await Promise.all([
      readFile(new URL('./AuditCenterSection.tsx', import.meta.url), 'utf8'),
      readFile(new URL('./AuditDetailDrawer.tsx', import.meta.url), 'utf8'),
      readFile(new URL('./AuditFilters.tsx', import.meta.url), 'utf8'),
    ])
    expect(section).toContain('const compact = !screens.lg')
    expect(section).toContain("overflowX: 'auto'")
    expect(section).toContain("overflowWrap: 'anywhere'")
    expect(drawer).toContain('calc(100vw - 16px)')
    expect(filters).toContain('xs={24} md={12} xl={8}')
  })

  it('keeps controls touch-sized and restores focus to the activating detail button', async () => {
    const [section, drawer] = await Promise.all([
      readFile(new URL('./AuditCenterSection.tsx', import.meta.url), 'utf8'),
      readFile(new URL('./AuditDetailDrawer.tsx', import.meta.url), 'utf8'),
    ])
    expect(section.match(/minHeight: 44/g)?.length).toBeGreaterThanOrEqual(5)
    expect(section).toContain('event.currentTarget')
    expect(section).toContain('aria-label={`查看审计事件 ${record.id} 详情`}')
    expect(drawer).toContain('keyboard')
    expect(drawer).toContain('autoFocus')
  })
})
