import { describe, expect, it } from 'vitest'
import { buildPublishObservationRequest } from './publish-observation.js'

describe('publish observation reporting', () => {
  it('transports normalized rejection evidence without a raw response', () => {
    const request = buildPublishObservationRequest({ remoteStatus: { found: true, state: 'rejected', requestId: 'req-1', simulated: false, rejection: { rawCode: 'TOP-27', message: '标题不合规', fields: [{ path: 'title', rawCode: 'TITLE-LONG', message: '标题过长' }] } } }, { source: 'reconcile', observedAt: '2026-08-25T00:00:00.000Z' })
    expect(request.status).toEqual({ found: true, state: 'rejected', request_id: 'req-1', simulated: false, platform_rejection: { raw_code: 'TOP-27', message: '标题不合规', fields: [{ path: 'title', raw_code: 'TITLE-LONG', message: '标题过长' }] } })
    expect(request).not.toHaveProperty('raw_response')
  })
})
