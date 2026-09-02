import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { incidentDetailCapabilities } from './IncidentDetailDrawer.js'

describe('IncidentDetailDrawer', () => {
  it('keeps support read/comment-only and platform ops mutable', () => {
    expect(incidentDetailCapabilities(false)).toEqual({ canRead: true, canComment: true, canTransition: false, canAssignCommander: false, canUpdateScope: false })
    expect(incidentDetailCapabilities(true)).toEqual({ canRead: true, canComment: true, canTransition: true, canAssignCommander: true, canUpdateScope: true })
  })

  it('announces detail loading and preserves a busy landmark for assistive technology', () => {
    return readFile(new URL('./IncidentDetailDrawer.tsx', import.meta.url), 'utf8').then((source) => {
      expect(source).toContain('<section aria-label="事故详情内容" aria-busy={props.loading}>')
      expect(source).toContain('<div role="status" aria-live="polite" aria-atomic="true" className="sr-only">')
      expect(source).toContain("正在加载事故详情，已有内容会保留。")
    })
  })
})
