import { afterEach, describe, expect, it } from 'vitest'
import { demoUnscannedAssetsEnabled, requireApprovedAssetForImageGeneration, service } from './server.js'

const previous = {
  profile: process.env.DEPLOYMENT_PROFILE,
  mode: process.env.ASSET_SCANNER_MODE,
  enabled: process.env.DEMO_UNSCANNED_ASSETS_ENABLED,
}

afterEach(() => {
  for (const [key, value] of Object.entries({ DEPLOYMENT_PROFILE: previous.profile, ASSET_SCANNER_MODE: previous.mode, DEMO_UNSCANNED_ASSETS_ENABLED: previous.enabled })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('demo unscanned image source gate', () => {
  it('admits only the matching workspace quarantine image with confirmed rights under explicit demo mode', () => {
    const workspaceId = 'ws_demo_image_source'
    const asset = service.registerAsset({ workspaceId, name: 'source.png', mimeType: 'image/png', sizeBytes: 12, sha256: 'a'.repeat(64), storageKey: `quarantine/${workspaceId}/source` })
    Object.assign(asset, { scanStatus: 'unscanned', rightsStatus: 'approved', rightsScope: 'commercial', aiModificationAllowed: true })
    service.assets.set(asset.id, asset)
    expect(() => requireApprovedAssetForImageGeneration(workspaceId, { platform: 'jd' }, [asset.id])).toThrow()
    Object.assign(process.env, { DEPLOYMENT_PROFILE: 'ecs', ASSET_SCANNER_MODE: 'deferred', DEMO_UNSCANNED_ASSETS_ENABLED: 'true' })
    expect(demoUnscannedAssetsEnabled()).toBe(true)
    expect(() => requireApprovedAssetForImageGeneration(workspaceId, { platform: 'jd' }, [asset.id])).not.toThrow()
    expect(() => requireApprovedAssetForImageGeneration('ws_other_image_source', { platform: 'jd' }, [asset.id])).toThrow()
    asset.storageKey = 'quarantine/ws_other_image_source/source'
    expect(() => requireApprovedAssetForImageGeneration(workspaceId, { platform: 'jd' }, [asset.id])).toThrow()
  })
})
