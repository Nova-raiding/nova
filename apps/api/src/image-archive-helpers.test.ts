import { describe, expect, it } from 'vitest'
import { parseRequestedImageSize, promoteLegacyDemoGeneratedAsset } from './image-archive-helpers.js'

describe('image archive requested size contract', () => {
  it('parses one strict positive width and height pair', () => {
    expect(parseRequestedImageSize('1024x4096')).toEqual({ width: 1024, height: 4096 })
    expect(parseRequestedImageSize(undefined)).toBeUndefined()
  })

  it('rejects extra segments and non-positive or unsafe dimensions', () => {
    for (const value of ['1024x4096xjunk', '1024', '0x4096', '-1x4096', '1x1.5', '999999999999999999x2']) {
      expect(() => parseRequestedImageSize(value)).toThrow('图片请求尺寸')
    }
  })
})

describe('legacy demo generated-image promotion', () => {
  it('promotes only generated quarantine assets to explicit unscanned state', () => {
    const asset = {
      workspaceId: 'ws_demo',
      storageKey: 'quarantine/ws_demo/generated_pending_abc/candidate-1.png',
      scanStatus: 'quarantined',
      scanVerdict: 'pending',
      scanReceiptId: 'old-receipt',
      scanReceiptDigest: 'old-digest',
      revision: 3,
    }
    expect(promoteLegacyDemoGeneratedAsset('ws_demo', asset)).toBe(true)
    expect(asset).toMatchObject({ scanStatus: 'unscanned', revision: 4 })
    expect(asset).not.toHaveProperty('scanVerdict')
    expect(asset).not.toHaveProperty('scanReceiptId')
    expect(asset).not.toHaveProperty('scanReceiptDigest')
  })

  it('does not reinterpret uploaded assets or assets from another workspace', () => {
    for (const asset of [
      { workspaceId: 'ws_demo', storageKey: 'quarantine/ws_demo/uploaded/file.png', scanStatus: 'quarantined' },
      { workspaceId: 'ws_other', storageKey: 'quarantine/ws_other/generated_pending_abc/candidate-1.png', scanStatus: 'quarantined' },
      { workspaceId: 'ws_demo', storageKey: 'quarantine/ws_demo/generated_pending_abc/candidate-1.png', scanStatus: 'clean' },
    ]) {
      expect(promoteLegacyDemoGeneratedAsset('ws_demo', asset)).toBe(false)
      expect(asset.scanStatus).not.toBe('unscanned')
    }
  })
})
