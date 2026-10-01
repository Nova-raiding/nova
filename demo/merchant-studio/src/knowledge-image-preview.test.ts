import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

describe('knowledge library image preview contract', () => {
  it('loads authenticated thumbnails when the knowledge section is active', () => {
    // The preview effect must cover the knowledge table as well as the image
    // workspace. Keep this as a source contract because the test environment
    // does not provide a browser Image implementation or an API server.
    expect(app).toMatch(/assetEntry\s*!==\s*'images'\s*&&\s*assetEntry\s*!==\s*'knowledge'/)
    expect(app).toContain('fetchAssetBlob(baseUrl, asset.id, controller.signal)')
    expect(app).toContain('setAssetPreviews(Object.fromEntries(previews))')
  })

  it('renders a preview in the knowledge file cell only for image assets', () => {
    expect(app).toContain('className="knowledge-file-thumb"')
    expect(app).toMatch(/assetPreviews\[asset\.id\].*asset\.mimeType\.toLowerCase\(\)\.startsWith\('image\/'\)/s)
    expect(app).toContain("style={{ width: 32, height: 32, flex: '0 0 auto', objectFit: 'cover', borderRadius: 6 }}")
    expect(app).toContain('title: \'文件\'')
  })

  it('keeps preview downloads fail closed to clean image assets', () => {
    expect(app).toMatch(/asset\.scanStatus\s*===\s*'clean'/)
    expect(app).toContain("asset.mimeType.toLowerCase().startsWith('image/')")
    expect(app).toContain('if (!baseUrl ||')
    expect(app).toContain('!assetStorageReady')
  })
})
