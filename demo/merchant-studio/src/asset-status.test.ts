import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolveAssetPrimaryAction, resolveAssetPrimaryStatus, resolveAssetSecondaryStatus, rightsConfirmationPayload, rightsScopeForConfirmation } from './asset-status.js'
import type { AssetMetadata } from './api'

const asset = (overrides: Partial<AssetMetadata> = {}): AssetMetadata => ({
  id: 'asset-1', name: '主图.jpg', mimeType: 'image/jpeg', sizeBytes: 1024,
  scanStatus: 'clean', rightsStatus: 'pending', parseStatus: 'succeeded',
  contentTrust: { classification: 'untrusted', mode: 'data_only', canOverrideInstructions: false, canTriggerTools: false, requiresMerchantConfirmation: true },
  references: [], revision: 1, createdAt: '2026-08-31T00:00:00Z', display: { primaryStatus: 'awaiting_rights', label: '等待确认使用权', sourceState: 'draft', reasons: [], nextAction: { method: 'asset.rights.update', label: '确认商用权益', allowed: true } }, ...overrides,
})

describe('asset primary status projection', () => {
  it('keeps processing presentation scoped to the active asset card', () => {
    const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
    expect(app).toContain('busy: Boolean(assetAction)')
    expect(app).toContain('resolveAssetPrimaryAction(asset, {')
  })

  it('prioritizes safety and fails closed for unknown scan states', () => {
    expect(resolveAssetPrimaryStatus(asset({ scanStatus: 'quarantined' })).label).toBe('安全检查中')
    expect(resolveAssetPrimaryStatus(asset({ scanStatus: 'rejected' })).key).toBe('blocked')
    expect(resolveAssetPrimaryStatus(asset({ scanStatus: 'future_state' })).key).toBe('unknown')
    expect(resolveAssetPrimaryStatus(asset({ scanStatus: 'future_state' }))).toMatchObject({
      label: '安全状态待核实', action: 'refresh', tone: 'amber',
    })
  })
  it('surfaces parsing recovery and rights confirmation', () => {
    expect(resolveAssetPrimaryStatus(asset({ parseStatus: 'failed', parseError: '无法读取' }))).toMatchObject({ label: '内容读取失败', action: 'manual_review', tone: 'red' })
    expect(resolveAssetPrimaryStatus(asset({ parseStatus: 'processing' })).label).toBe('正在读取内容')
    expect(resolveAssetPrimaryStatus(asset({ rightsStatus: 'pending' })).label).toBe('等待确认使用权')
  })
  it('routes unusable or rejected rights back to rights confirmation, not fact review', () => {
    const unusableScope = asset({
      rightsStatus: 'approved', rightsScope: 'unusable', factsConfirmedBy: 'merchant-1',
      readiness: { status: 'blocked', reasons: ['商用权益被拒绝或不可用'] },
      display: { primaryStatus: 'rights_blocked', label: '使用权益受限', sourceState: 'blocked', reasons: ['商用权益被拒绝或不可用'], nextAction: { method: 'asset.rights.update', label: '重新确认使用权', allowed: true } },
    })
    const rejectedStatus = asset({ rightsStatus: 'rejected', rightsScope: 'unusable', factsConfirmedBy: 'merchant-1' })

    expect(resolveAssetPrimaryAction(unusableScope)).toMatchObject({ kind: 'confirm_rights', label: '调整权益范围' })
    expect(resolveAssetPrimaryAction(rejectedStatus)).toMatchObject({ kind: 'confirm_rights', label: '确认权益范围' })
    expect(rightsScopeForConfirmation(unusableScope)).toBe('internal_only')
    expect(rightsScopeForConfirmation(asset({ rightsScope: 'mystery' }))).toBe('internal_only')
    expect(rightsScopeForConfirmation(asset({ rightsScope: 'limited_use' }))).toBe('limited_use')
  })
  it('does not upgrade internal or restricted scopes to commercial generation', () => {
    expect(rightsConfirmationPayload('internal_only')).toEqual({
      rights_status: 'approved', rights_scope: 'internal_only', usage_scopes: ['internal_only'], ai_modification_allowed: false,
    })
    expect(rightsConfirmationPayload('limited_use')).toEqual({
      rights_status: 'approved', rights_scope: 'limited_use', usage_scopes: ['limited_use'], ai_modification_allowed: false,
    })
    expect(rightsConfirmationPayload('commercial_authorized').usage_scopes).toEqual(['commercial', 'ai_generation'])
    expect(rightsConfirmationPayload('unknown')).toEqual({
      rights_status: 'approved', rights_scope: 'internal_only', usage_scopes: ['internal_only'], ai_modification_allowed: false,
    })
    for (const rightsScope of ['internal_only', 'limited_use']) {
      expect(resolveAssetPrimaryStatus(asset({ rightsStatus: 'approved', rightsScope, factsConfirmedBy: 'merchant-1' }))).toMatchObject({
        key: 'blocked', action: 'confirm_rights', tone: 'red',
      })
      expect(resolveAssetPrimaryAction(asset({ rightsStatus: 'approved', rightsScope }))).toMatchObject({ label: '调整权益范围' })
    }
  })
  it('only shows ready after trusted lifecycle fields are in an allowed state', () => {
    expect(resolveAssetPrimaryStatus(asset({ rightsStatus: 'approved', factsConfirmedBy: 'merchant-1', display: { primaryStatus: 'ready', label: '可以用于当前任务', sourceState: 'ready', reasons: [], nextAction: null } }))).toMatchObject({ key: 'ready', label: '可以用于生成', tone: 'green' })
    expect(resolveAssetPrimaryStatus(asset({ rightsStatus: 'approved' }))).toMatchObject({ key: 'facts', label: '等待核对素材事实' })
    expect(resolveAssetPrimaryStatus(asset({ rightsStatus: 'unknown' })).key).toBe('rights')
    expect(resolveAssetPrimaryStatus(asset({ display: undefined, rightsStatus: 'approved', factsConfirmedBy: 'merchant-1' })).label).toBe('暂不能确认可用性')
  })
  it('keeps raw lifecycle details secondary to one primary status', () => {
    expect(resolveAssetSecondaryStatus(asset({ rightsStatus: 'approved', factsConfirmedBy: 'merchant-1' }))).toBe('扫描通过 · 权益已确认 · 事实已确认')
    expect(resolveAssetSecondaryStatus(asset({ scanStatus: 'future_state' }))).toContain('扫描状态待核实')
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
