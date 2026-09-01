import { describe, expect, it } from 'vitest'
import { requiresWorkerActorAuthorization } from './server.js'

describe('worker system-delivery authorization boundary', () => {
  it('uses commercial-only recheck for automatic initial asset scans', () => {
    for (const eventType of ['asset.uploaded', 'asset.generated_quarantined', 'asset.video_quarantined']) {
      expect(requiresWorkerActorAuthorization(eventType, 'asset.scan.execute')).toBe(false)
    }
  })

  it('retains actor authorization for manual redrive and other worker operations', () => {
    expect(requiresWorkerActorAuthorization('asset.scan_redrive_requested', 'asset.scan.execute')).toBe(true)
    expect(requiresWorkerActorAuthorization('generation.requested', 'generation.execute')).toBe(true)
    expect(requiresWorkerActorAuthorization('sync.requested', 'catalog.sync.execute')).toBe(true)
  })
})
