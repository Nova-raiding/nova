import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('video cost preflight contract', () => {
  it('guards both rendering entrypoints before provider execution without a legacy wallet debit', () => {
    const source = readFileSync('apps/api/src/server.ts', 'utf8')
    expect(source.match(/await requireVideoModelCostPreflight\(\)/gu)).toHaveLength(2)
    const dedicatedRoute = source.slice(source.indexOf("case 'multimodal.video.request':"), source.indexOf("case 'multimodal.video.get':"))
    expect(dedicatedRoute).not.toContain('debitPluginWallet')
    expect(dedicatedRoute.indexOf('await requireVideoModelCostPreflight()')).toBeLessThan(dedicatedRoute.indexOf('videoGenerator.generate'))
  })
})
