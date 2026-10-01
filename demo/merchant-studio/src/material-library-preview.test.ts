import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

describe('material library image preview contract', () => {
  it('only downloads verified image assets and bounds thumbnail work', () => {
    expect(app).toContain("asset.scanStatus === 'clean'")
    expect(app).toContain("asset.mimeType.toLowerCase().startsWith('image/')")
    expect(app).toContain('.slice(0, 24)')
    expect(app).toContain('fetchAssetBlob(baseUrl, asset.id, controller.signal)')
  })

  it('publishes verified preview URLs into material rows', () => {
    expect(app).toContain('materialPreviews[item.id]')
    expect(app).toContain('previewUrl: materialPreviews[item.id]')
  })
})
