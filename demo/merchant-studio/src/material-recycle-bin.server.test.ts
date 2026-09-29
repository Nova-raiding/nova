import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MaterialRecycleBinWorkspace, recycleMaterialFromServer } from './App'
import type { TrashedAsset } from './api'

const trashedAsset: TrashedAsset = {
  asset: {
    id: 'asset-server-1',
    name: 'server-owned-material.png',
    mimeType: 'image/png',
    sizeBytes: 1024,
    rightsStatus: 'pending',
    scanStatus: 'clean',
    parseStatus: 'pending',
    contentTrust: { classification: 'untrusted', mode: 'data_only', canOverrideInstructions: false, canTriggerTools: false, requiresMerchantConfirmation: true },
    references: [],
    revision: 4,
    createdAt: '2026-09-20T10:00:00.000Z',
  },
  deleted_at: '2026-09-28T10:00:00.000Z',
  expires_at: '2026-10-05T10:00:00.000Z',
  deleted_by: 'merchant-user-1',
  revision: 2,
}

describe('server-backed Merchant recycle bin', () => {
  it('maps the server asset and lifecycle timestamps without adding browser-only attribution', () => {
    const item = recycleMaterialFromServer(trashedAsset)

    expect(item.id).toBe('asset-server-1')
    expect(item.name).toBe('server-owned-material.png')
    expect(item.format).toBe('PNG')
    expect(item.deletedAt).toBe(trashedAsset.deleted_at)
    expect(item.expiresAt).toBe(trashedAsset.expires_at)
    expect(item.deletedBy).toBe(trashedAsset.deleted_by)
    expect(item.revision).toBe(2)
    expect(item).not.toHaveProperty('storeName')
  })

  it('does not report empty or fabricate records before the server read', () => {
    const markup = renderToStaticMarkup(createElement(MaterialRecycleBinWorkspace, { baseUrl: 'https://api.example.test' }))

    expect(markup).toContain('正在读取服务端回收站')
    expect(markup).toContain('<strong>—</strong>')
    expect(markup).not.toContain('回收站为空')
    expect(markup).not.toContain('server-owned-material.png')
    expect(markup).not.toContain('清除本地记录')
  })
})
