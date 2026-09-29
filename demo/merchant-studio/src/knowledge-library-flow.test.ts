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
})
