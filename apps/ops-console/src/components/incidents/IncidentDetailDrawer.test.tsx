import { describe, expect, it } from 'vitest'
import { incidentDetailCapabilities } from './IncidentDetailDrawer.js'

describe('IncidentDetailDrawer', () => {
  it('keeps support read/comment-only and platform ops mutable', () => {
    expect(incidentDetailCapabilities(false)).toEqual({ canRead: true, canComment: true, canTransition: false, canAssignCommander: false, canUpdateScope: false })
    expect(incidentDetailCapabilities(true)).toEqual({ canRead: true, canComment: true, canTransition: true, canAssignCommander: true, canUpdateScope: true })
  })
})
