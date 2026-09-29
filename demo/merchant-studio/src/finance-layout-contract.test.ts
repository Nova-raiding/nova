import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

describe('reviewed finance chart layout', () => {
  it('reserves the chart slot for unread, failed and empty statements', () => {
    expect(app).toContain('<p className="finance-chart finance-chart-empty" role="status">{statementEntries === null')
    expect(css).toMatch(/\.finance-chart-empty\s*\{[^}]*margin:\s*0\s*;/)
    expect(css).toMatch(/\.finance-chart-empty\s*\{[^}]*overflow-wrap:\s*anywhere\s*;/)
  })

  it('keeps the reviewed desktop chart height and truthful no-data messages', () => {
    expect(css).toMatch(/\.finance-chart\s*\{\s*height:\s*360px;/)
    expect(app).toContain('? statementNote')
    expect(app).toContain('entriesInRange?.length === 0')
    expect(app).toContain('没有${statementUnreadable > 0 ? \'可识别的\' : \'\'}创意点流水，不显示趋势图。')
    expect(app).toContain('只有消耗类流水计入趋势')
    expect(app).toContain('<PointUsageChart items={chartItems} label={chartLabel} />')
  })
})
