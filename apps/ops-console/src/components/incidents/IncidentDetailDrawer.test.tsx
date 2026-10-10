import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { incidentDetailCapabilities } from './IncidentDetailDrawer.js'

describe('IncidentDetailDrawer', () => {
  it('keeps support read/comment-only and platform ops mutable', () => {
    expect(incidentDetailCapabilities(false)).toEqual({ canRead: true, canComment: true, canTransition: false, canAssignCommander: false, canUpdateScope: false })
    expect(incidentDetailCapabilities(true)).toEqual({ canRead: true, canComment: true, canTransition: true, canAssignCommander: true, canUpdateScope: true })
  })

  it('blocks detail mutations until the selected incident is verified', () => {
    expect(incidentDetailCapabilities(true, false)).toEqual({ canRead: true, canComment: false, canTransition: false, canAssignCommander: false, canUpdateScope: false })
    expect(incidentDetailCapabilities(true, true, true)).toEqual({ canRead: true, canComment: false, canTransition: false, canAssignCommander: false, canUpdateScope: false })
  })

  it('announces detail loading and preserves a busy landmark for assistive technology', () => {
    return readFile(new URL('./IncidentDetailDrawer.tsx', import.meta.url), 'utf8').then((source) => {
      expect(source).toContain('<section aria-label="事故详情内容" aria-busy={props.loading}>')
      expect(source).toContain('<div role="status" aria-live="polite" aria-atomic="true" className="sr-only">')
      expect(source).toContain("正在加载事故详情和时间线。")
    })
  })

  it('shows distinct retry states instead of presenting failed loads as empty or verified data', async () => {
    const source = await readFile(new URL('./IncidentDetailDrawer.tsx', import.meta.url), 'utf8')
    expect(source).toContain("props.detailVerified ? '事故详情' : '事故详情待验证'")
    expect(source).toContain("title={props.detailError ? '事故详情加载失败' : '正在验证事故详情'}")
    expect(source).toContain('onClick={props.onRetryDetail}')
    expect(source).toContain('title="时间线加载失败"')
    expect(source).toContain('onClick={props.onRetryTimeline}')
    expect(source).toContain('props.timelineVerified ? <Typography.Paragraph type="secondary">暂无时间线记录。</Typography.Paragraph>')
    expect(source).not.toContain(': <Typography.Paragraph type="secondary">暂无时间线记录。</Typography.Paragraph>')
  })

  it('rehydrates editable fields after verified detail and revision changes for the same incident', async () => {
    const source = await readFile(new URL('./IncidentDetailDrawer.tsx', import.meta.url), 'utf8')
    expect(source).toContain("setCommanderId(incident?.commanderId ?? '')")
    expect(source).toContain("setComponents(incident?.affectedComponents.join(', ') ?? '')")
    expect(source).toContain("setWorkspaces(incident?.affectedWorkspaceIds.join(', ') ?? '')")
    expect(source).toContain('[incident?.id, incident?.revision, incident?.commanderId, incident?.affectedComponents, incident?.affectedWorkspaceIds, props.detailVerified]')
  })
})
