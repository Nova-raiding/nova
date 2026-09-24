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
    const configurationRequired = assetScanWaitingState({})
    const states = [
      assetScanWaitingState({ ASSET_SCAN_AUTOMATION_MODE: 'external_callback' }),
      assetScanWaitingState({ ASSET_SCANNER_MODE: 'clamav_worker' }),
      configurationRequired,
    ]
    expect(states[0]).toMatchObject({ state: 'pending', mode: 'platform_worker', userActionRequired: false })
    expect(states[1]).toMatchObject({ state: 'pending', mode: 'platform_worker', userActionRequired: false })
    expect(configurationRequired).toMatchObject({ state: 'configuration_required', userActionRequired: false })
    for (const state of states.slice(0, 2)) {
      expect(state.message).toContain('等待平台安全扫描回调')
      expect(state.message).toContain('尚未确认扫描通过')
      expect(state.message).toContain('稍后查询素材状态')
    }
    expect(configurationRequired.message).toContain('当前暂时无法检查图片')
    expect(configurationRequired.message).toContain('稍后查询素材状态')
    for (const state of states) {
      expect(state.message).not.toMatch(/正在自动|通过后自动继续|无需操作|扫描完成|扫描证据/u)
    }
  })
})
