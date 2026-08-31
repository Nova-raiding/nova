import { describe, expect, it } from 'vitest'
import { assetScanWaitingState, localAssetScanFixture } from './asset-scan-automation.js'

const asset = { assetId: 'asset_123', sha256: 'a'.repeat(64) }

describe('asset scan automation policy', () => {
  it('enables explicitly labelled fixture evidence only in local acceptance', () => {
    const decision = localAssetScanFixture(asset, {
      NODE_ENV: 'development',
      DEPLOYMENT_PROFILE: 'local_acceptance',
      LOCAL_COMPOSE: 'true',
      ALLOW_LOCAL_ASSET_SCAN_FIXTURE: 'true',
    })
    expect(decision).toMatchObject({ mode: 'local_fixture', productionEvidence: false, label: '本地演示扫描，不代表生产安全扫描' })
    expect(decision?.evidenceRef).toMatch(/^fixture:\/\/local-asset-scan\/v1\/[a-f0-9]{64}$/u)
  })

  it('can never enable fixture evidence in production', () => {
    expect(localAssetScanFixture(asset, {
      NODE_ENV: 'production',
      DEPLOYMENT_PROFILE: 'local_acceptance',
      LOCAL_COMPOSE: 'true',
      ALLOW_LOCAL_ASSET_SCAN_FIXTURE: 'true',
    })).toBeNull()
  })

  it('never asks a merchant or administrator to manufacture evidence', () => {
    const states = [
      assetScanWaitingState({ ASSET_SCAN_AUTOMATION_MODE: 'external_callback' }),
      assetScanWaitingState({ ASSET_SCANNER_MODE: 'clamav_worker' }),
      assetScanWaitingState({}),
    ]
    expect(states[0]).toMatchObject({ state: 'pending', mode: 'platform_worker', userActionRequired: false })
    expect(states[1]).toMatchObject({ state: 'pending', mode: 'platform_worker', userActionRequired: false })
    expect(states[2]).toMatchObject({ state: 'configuration_required', userActionRequired: false })
    for (const state of states) {
      expect(state.message).not.toMatch(/管理员|扫描完成|扫描证据|运营后台|上线阻断/u)
    }
  })
})
