import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

describe('merchant knowledge library flow wiring', () => {
  it('uses the fail-closed knowledge projection for summary counts', () => {
    expect(app).toContain('const knowledgeCounts = countKnowledgeAssets(visibleAssets)')
    expect(app).not.toContain("asset.parseStatus === 'succeeded' && asset.rightsStatus === 'approved'")
  })

  it('exposes the server-backed next action from every knowledge row', () => {
    expect(app).toContain("title: '生成状态 / 下一步'")
    expect(app).toContain('<KnowledgeBindingStatus')
    expect(app).toContain("const actionLabel = action.kind === 'none' && !binding.ready ? '刷新状态' : action.label")
    expect(app).toContain('? () => runPrimaryAssetAction(asset)')
    expect(app).toContain(': !binding.ready')
  })

  it('refreshes a partially successful batch and reports the accepted count', () => {
    const upload = app.slice(app.indexOf('const uploadFiles = async (files: FileList | null) => {'), app.indexOf('const extractBrand = async () => {'))
    expect(upload).toContain('uploadedCount += 1')
    expect(upload).toContain('const refreshed = uploadedCount > 0 ? await load() : false')
    expect(upload).toContain("refreshed ? '列表已刷新' : '素材列表刷新失败，请刷新重试'")
  })
})
