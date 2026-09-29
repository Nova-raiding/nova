import { describe, expect, it, vi } from 'vitest'
import type { AssetMetadata } from './api'
import { BrandAssetPreviewRegistry, brandAssetFileError, brandAssetMatchesKind, isUsableBrandAsset } from './material-brand-assets'

const asset: AssetMetadata = {
  id: 'asset-brand-1', name: 'brand-logo.png', mimeType: 'image/png', sizeBytes: 16,
  scanStatus: 'clean', rightsStatus: 'approved', rightsScope: 'commercial_authorized',
  parseStatus: 'succeeded', factsConfirmedBy: 'merchant-1', factsConfirmedAt: '2026-09-29T00:00:00Z',
  readiness: { status: 'ready', reasons: [] },
  contentTrust: { classification: 'untrusted', mode: 'data_only', canOverrideInstructions: false, canTriggerTools: false, requiresMerchantConfirmation: true },
  references: [], revision: 1, createdAt: '2026-09-29T00:00:00Z',
}

describe('brand asset upload contract', () => {
  it('accepts image Logos and supported document formats, rejecting invalid files before upload', () => {
    expect(brandAssetFileError(new File(['image'], 'logo.png', { type: 'image/png' }), 'logo')).toBe('')
    expect(brandAssetFileError(new File(['text'], 'guide.pdf', { type: 'application/pdf' }), 'document')).toBe('')
    expect(brandAssetFileError(new File(['text'], 'guide.exe'), 'document')).toContain('品牌文档请使用')
    expect(brandAssetFileError(new File(['text'], 'not-image.txt', { type: 'text/plain' }), 'logo')).toBe('Logo 请使用图片文件。')
    expect(brandAssetFileError(new File([], 'empty.pdf'), 'document')).toBe('不能上传空文件。')
    expect(brandAssetMatchesKind(asset, 'logo')).toBe(true)
    expect(brandAssetMatchesKind({ ...asset, name: 'guide.pdf', mimeType: 'application/pdf' }, 'document')).toBe(true)
    expect(brandAssetMatchesKind(asset, 'document')).toBe(false)
  })

  it('allows scoped settings to reference only assets that passed the server readiness gates', () => {
    expect(isUsableBrandAsset(asset)).toBe(true)
    expect(isUsableBrandAsset({ ...asset, scanStatus: 'quarantined' })).toBe(false)
    expect(isUsableBrandAsset({ ...asset, rightsStatus: 'pending' })).toBe(false)
    expect(isUsableBrandAsset({ ...asset, parseStatus: 'pending' })).toBe(false)
    expect(isUsableBrandAsset({ ...asset, factsConfirmedAt: undefined })).toBe(false)
    expect(isUsableBrandAsset({ ...asset, readiness: { status: 'blocked', reasons: ['scan'] } })).toBe(false)
    expect(isUsableBrandAsset(undefined)).toBe(false)
  })

  it('revokes replaced previews and clears every object URL when the workspace scope exits', () => {
    const registry = new BrandAssetPreviewRegistry()
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    try {
      const file = new File(['image'], 'logo.png', { type: 'image/png' })
      expect(registry.set('asset-brand-1', file)).toBe('blob:first')
      expect(registry.set('asset-brand-1', file)).toBe('blob:second')
      expect(revoke).toHaveBeenCalledWith('blob:first')
      expect(registry.get('asset-brand-1')).toBe('blob:second')
      registry.clear()
      expect(revoke).toHaveBeenCalledWith('blob:second')
      expect(registry.get('asset-brand-1')).toBeUndefined()
    } finally {
      create.mockRestore()
      revoke.mockRestore()
    }
  })
})
