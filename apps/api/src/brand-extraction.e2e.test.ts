import { afterEach, describe, expect, it } from 'vitest'
import { server, service } from './server.js'

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null }

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, () => { server.removeListener('error', onError); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function json<T>(response: Response) { return await response.json() as Envelope<T> }

describe('brand extraction and explicit confirmation', () => {
  afterEach(async () => { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())) })

  it('extracts read-only candidates and saves only merchant-confirmed fields', async () => {
    const base = await start()
    const workspaceId = `ws_brand_extract_${Date.now()}`
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const asset = service.registerAsset({ workspaceId, name: '品牌手册.json', mimeType: 'application/json', sizeBytes: 128, sha256: 'b'.repeat(64), storageKey: `quarantine/${workspaceId}/brand.json` })
    service.updateAssetParse({ workspaceId, assetId: asset.id, state: 'succeeded', source: 'parser', facts: { 品牌名称: '云朵轻户外', 品牌定位: '城市轻户外', 品牌调性: ['克制', '清晰'], 品牌色: ['松石绿', '米白'] } })

    const extracted = await fetch(`${base}/v1/brand-profile/extract`, { method: 'POST', headers, body: JSON.stringify({ asset_ids: [asset.id] }) }).then(json<any>)
    expect(extracted.error).toBeNull()
    expect(extracted.data.fields).toMatchObject({ name: { value: '云朵轻户外', confidence: 0.9, confirmationRequired: true }, positioning: { value: '城市轻户外' }, colors: { value: ['松石绿', '米白'] } })
    expect(service.getBrandProfile(workspaceId)).toBeUndefined()

    const saved = await fetch(`${base}/v1/brand-profile`, { method: 'PUT', headers, body: JSON.stringify({ name: extracted.data.fields.name.value, positioning: extracted.data.fields.positioning.value, source: `brand.extract:${asset.id}`, conflict_resolutions: { name: 'candidate', positioning: 'candidate' } }) }).then(json<any>)
    expect(saved.error).toBeNull()
    expect(saved.data).toMatchObject({ name: '云朵轻户外', positioning: '城市轻户外', revision: 1 })
    expect(saved.data).not.toHaveProperty('tone')
    expect(saved.data).not.toHaveProperty('details.colors')

    const crossWorkspace = await fetch(`${base}/v1/brand-profile/extract`, { method: 'POST', headers: { ...headers, 'x-workspace-id': `${workspaceId}_other` }, body: JSON.stringify({ asset_ids: [asset.id] }) }).then(json<any>)
    expect(crossWorkspace.error?.code).toBe('ASSET_NOT_FOUND')
  })

  it('rejects extraction before any brand material exists', async () => {
    const base = await start()
    const response = await fetch(`${base}/v1/brand-profile/extract`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': `ws_empty_brand_${Date.now()}` }, body: '{}' }).then(json<any>)
    expect(response.error?.code).toBe('BRAND_ASSETS_REQUIRED')
  })

  it('persists strong visual rules and blocks real generation entrypoints until font rights are approved', async () => {
    const base = await start()
    const workspaceId = `ws_brand_visual_${Date.now()}`
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const invalid = await fetch(`${base}/v1/brand-profile`, { method: 'PUT', headers, body: JSON.stringify({ name: '视觉品牌', visual_rules: { colors: { primary: ['red'], secondary: [], forbidden: [] } } }) }).then(json<any>)
    expect(invalid.error?.code).toBe('BRAND_VISUAL_RULES_INVALID')

    const saved = await fetch(`${base}/v1/brand-profile`, { method: 'PUT', headers, body: JSON.stringify({ name: '视觉品牌', visual_rules: { colors: { primary: ['#123456'], secondary: ['#ABCDEF'], forbidden: ['#FF0000'] }, fonts: [{ family: '待授权字体', licenseStatus: 'unknown' }], restrictedSubjects: { people: ['某艺人'], spokespersons: ['竞品代言人'], intellectualProperties: ['未授权动漫角色'], prohibitedContent: ['吸烟场景'] } } }) }).then(json<any>)
    expect(saved.error).toBeNull()
    expect(saved.data.visualRules).toMatchObject({ colors: { primary: ['#123456'] }, fonts: [{ family: '待授权字体', licenseStatus: 'unknown' }] })
    expect(saved.data.visualRules.restrictedSubjects).toMatchObject({ people: ['某艺人'], intellectualProperties: ['未授权动漫角色'] })

    const imported = await fetch(`${base}/v1/products/import`, { method: 'POST', headers, body: JSON.stringify({ platform: 'taobao', title: '视觉规则商品', local_product_key: 'visual-rules-product', price: 99, stock: 5 }) }).then(json<any>)
    await fetch(`${base}/v1/products/${encodeURIComponent(imported.data.id)}/confirm`, { method: 'POST', headers, body: '{}' })
    const blocked = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'creative.brief', params: { product_id: imported.data.id, asset_type: 'banner' } }) }).then(response => response.json()) as { error: { code: string; details: { issues: Array<{ code: string }> } } }
    expect(blocked.error).toMatchObject({ code: 'BRAND_VISUAL_RULES_BLOCKED', details: { issues: [expect.objectContaining({ code: 'FONT_LICENSE_NOT_APPROVED' })] } })

    const corrected = await fetch(`${base}/v1/brand-profile`, { method: 'PUT', headers, body: JSON.stringify({ name: '视觉品牌', visual_rules: { colors: { primary: ['#123456'], secondary: ['#ABCDEF'], forbidden: ['#FF0000'] }, fonts: [{ family: '已授权字体', licenseStatus: 'approved' }] }, conflict_resolutions: { visualRules: 'candidate' } }) }).then(json<any>)
    expect(corrected.data.visualRules.fonts[0]).toMatchObject({ family: '已授权字体', licenseStatus: 'approved' })
    const generated = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'creative.brief', params: { product_id: imported.data.id, asset_type: 'banner' } }) }).then(response => response.json()) as { data: { result: { assetType: string } } }
    expect(generated.data.result.assetType).toBe('banner')
  })
})
