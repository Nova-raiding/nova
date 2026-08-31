import { describe, expect, it } from 'vitest'
import { resolveAssetPrimaryAction, resolveAssetPrimaryStatus, resolveAssetSecondaryStatus } from './asset-status.js'
import type { AssetMetadata } from './api'

const asset = (overrides: Partial<AssetMetadata> = {}): AssetMetadata => ({
  id: 'asset-1', name: '主图.jpg', mimeType: 'image/jpeg', sizeBytes: 1024,
  scanStatus: 'clean', rightsStatus: 'pending', parseStatus: 'succeeded',
  contentTrust: { classification: 'untrusted', mode: 'data_only', canOverrideInstructions: false, canTriggerTools: false, requiresMerchantConfirmation: true },
  references: [], revision: 1, createdAt: '2026-08-31T00:00:00Z', display: { primaryStatus: 'awaiting_rights', label: '等待确认使用权', sourceState: 'draft', reasons: [], nextAction: { method: 'asset.rights.update', label: '确认商用权益', allowed: true } }, ...overrides,
})

describe('asset primary status projection', () => {
  it('prioritizes safety and fails closed for unknown scan states', () => {
    expect(resolveAssetPrimaryStatus(asset({ scanStatus: 'quarantined' })).label).toBe('安全检查中')
    expect(resolveAssetPrimaryStatus(asset({ scanStatus: 'rejected' })).key).toBe('blocked')
    expect(resolveAssetPrimaryStatus(asset({ scanStatus: 'future_state' })).label).toBe('安全检查中')
  })
  it('surfaces parsing recovery and rights confirmation', () => {
    expect(resolveAssetPrimaryStatus(asset({ parseStatus: 'failed', parseError: '无法读取' }))).toMatchObject({ label: '内容读取失败', action: 'manual_review', tone: 'red' })
    expect(resolveAssetPrimaryStatus(asset({ parseStatus: 'processing' })).label).toBe('正在读取内容')
    expect(resolveAssetPrimaryStatus(asset({ rightsStatus: 'pending' })).label).toBe('等待确认使用权')
  })
  it('only shows ready after trusted lifecycle fields are in an allowed state', () => {
    expect(resolveAssetPrimaryStatus(asset({ rightsStatus: 'approved', factsConfirmedBy: 'merchant-1', display: { primaryStatus: 'ready', label: '可以用于当前任务', sourceState: 'ready', reasons: [], nextAction: null } }))).toMatchObject({ key: 'ready', label: '可以用于生成', tone: 'green' })
    expect(resolveAssetPrimaryStatus(asset({ rightsStatus: 'approved' }))).toMatchObject({ key: 'facts', label: '等待核对素材事实' })
    expect(resolveAssetPrimaryStatus(asset({ rightsStatus: 'unknown' })).key).toBe('rights')
    expect(resolveAssetPrimaryStatus(asset({ display: undefined, rightsStatus: 'approved', factsConfirmedBy: 'merchant-1' })).label).toBe('暂不能确认可用性')
  })
  it('keeps raw lifecycle details secondary to one primary status', () => {
    expect(resolveAssetSecondaryStatus(asset({ rightsStatus: 'approved', factsConfirmedBy: 'merchant-1' }))).toBe('扫描通过 · 权益已确认 · 事实已确认')
  })
  it('maps every lifecycle state to one safe next action', () => {
    expect(resolveAssetPrimaryAction(asset({ scanStatus: 'quarantined' }))).toMatchObject({ kind: 'refresh', label: '刷新状态' })
    expect(resolveAssetPrimaryAction(asset({ parseStatus: 'pending' }))).toMatchObject({ kind: 'parse', label: '读取素材事实' })
    expect(resolveAssetPrimaryAction(asset({ rightsStatus: 'pending' }))).toMatchObject({ kind: 'confirm_rights' })
    expect(resolveAssetPrimaryAction(asset({ rightsStatus: 'approved' }))).toMatchObject({ kind: 'confirm_facts' })
    expect(resolveAssetPrimaryAction(asset({ scanStatus: 'rejected' }))).toMatchObject({ kind: 'upload', label: '重新上传素材' })
    expect(resolveAssetPrimaryAction(asset({ display: undefined })).disabled).toBe(false)
    expect(resolveAssetPrimaryAction(asset({ display: undefined }), { configured: false }).disabled).toBe(true)
  })
})
