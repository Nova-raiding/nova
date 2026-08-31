import { describe, expect, it } from 'vitest'
import { evaluateCompetitorReferencePolicy, type CompetitorReferencePolicyInput } from './competitor-reference-policy.js'

const baseInput = (overrides: Partial<CompetitorReferencePolicyInput> = {}): CompetitorReferencePolicyInput => ({
  scope: { workspaceId: 'ws_local', brandId: 'brand_local', productId: 'product_local' },
  reference: {
    url: 'https://example.com/public-campaign',
    platform: 'tmall',
    fetchedAt: '2026-08-28T08:00:00.000Z',
    access: { kind: 'public', evidence: 'Public product page observed without authentication' },
  },
  extracted: {
    structures: ['问题场景→商品证据→适用边界→行动号召'],
    themes: ['城市通勤中的轻量体验'],
    trends: ['移动端首屏减少文字密度'],
    sellingPoints: [],
    originalSpans: [],
    assets: [],
  },
  candidate: { title: '本地商品详情页', body: '根据本商品已确认事实说明使用方式。', sellingPoints: [], claims: [], assetUses: [] },
  ...overrides,
})

describe('competitor reference compliance policy', () => {
  it('blocks Chinese synonym rewrites that preserve a competitor sentence', () => {
    const source = '采用极简布局，突出核心卖点，并以真实场景建立可信感'
    const result = evaluateCompetitorReferencePolicy(baseInput({
      extracted: { structures: ['利益点→证据→场景'], themes: [], trends: [], sellingPoints: [], originalSpans: [{ text: source }] },
      candidate: { body: '使用简约版式，强调主要利益点，通过实际使用场景营造可靠感。', claims: [], assetUses: [] },
    }))

    expect(result.allowed).toBe(false)
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'COMPETITOR_NEAR_COPY', severity: 'error' }))
    expect(result.removedSpans).toContainEqual(expect.objectContaining({ source: 'candidate_content', field: 'body[0]' }))
    expect(result.humanReview).toMatchObject({ required: true, reasons: expect.arrayContaining(['COMPETITOR_NEAR_COPY']) })
  })

  it('normalizes English synonym rewrites before similarity comparison', () => {
    const result = evaluateCompetitorReferencePolicy(baseInput({
      extracted: { originalSpans: [{ text: 'A minimalist layout highlights the core benefit and builds trust through a real-life setting.' }] },
      candidate: { body: 'A minimal composition emphasizes the key benefit and creates credibility with a real scenario.', claims: [], assetUses: [] },
    }))

    expect(result.allowed).toBe(false)
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'COMPETITOR_NEAR_COPY', similarity: expect.any(Number) }))
  })

  it.each([
    {
      name: 'Chinese punctuation, stop words and whitespace',
      source: '采用极简布局，突出核心卖点，并以真实场景建立可信感',
      candidate: '使用  简约版式；强调主要、利益点，\n通过实际使用场景营造可靠感。',
    },
    {
      name: 'zero-width characters',
      source: '采用极简布局，突出核心卖点，并以真实场景建立可信感',
      candidate: [...'使用简约版式强调主要利益点通过实际使用场景营造可靠感'].join('\u200b'),
    },
    {
      name: 'sentence splitting',
      source: '采用极简布局，突出核心卖点，并以真实场景建立可信感',
      candidate: '使用简约版式。强调主要利益点。通过实际使用场景营造可靠感。',
    },
    {
      name: 'NFKC and case folding',
      source: 'Use the minimalist layout to highlight the core benefit and build trust through a real-life setting.',
      candidate: 'ＵＳＥ MINIMAL LAYOUT；EMPHASIZE THE KEY BENEFIT，CREATE CREDIBILITY WITH A REAL SCENARIO.',
    },
  ])('blocks adversarial similarity bypass: $name', ({ source, candidate }) => {
    const result = evaluateCompetitorReferencePolicy(baseInput({
      extracted: { originalSpans: [{ text: source }] },
      candidate: { body: candidate, claims: [], assetUses: [] },
    }))

    expect(result.allowed).toBe(false)
    expect(result.findings.map(item => item.code)).toContain('COMPETITOR_NEAR_COPY')
    expect(result.removedSpans.some(span => span.source === 'candidate_content')).toBe(true)
  })

  it('blocks long verbatim reuse and source excerpts above the short-quote limit', () => {
    const copied = 'This lightweight commuter jacket uses a layered breathable construction that stays comfortable through changing weather and crowded daily travel.'
    const result = evaluateCompetitorReferencePolicy(baseInput({
      extracted: { structures: [], themes: [], trends: [], sellingPoints: [], originalSpans: [{ text: copied }] },
      candidate: { body: `New arrival. ${copied} Shop now.`, claims: [], assetUses: [] },
      thresholds: { maxShortQuoteUnits: 12 },
    }))

    expect(result.allowed).toBe(false)
    expect(result.findings.map(item => item.code)).toEqual(expect.arrayContaining(['COMPETITOR_QUOTE_LIMIT_EXCEEDED', 'COMPETITOR_VERBATIM_COPY']))
    expect(result.removedSpans.some(span => span.text.includes('lightweight commuter jacket'))).toBe(true)
  })

  it('blocks competitor facts that are transferred without target-product evidence', () => {
    const result = evaluateCompetitorReferencePolicy(baseInput({
      extracted: {
        structures: [], themes: [], trends: [], originalSpans: [], assets: [],
        sellingPoints: [{ text: '经实验室测试可连续防水 48 小时' }],
      },
      candidate: {
        body: '这款商品经实验室测试可连续防水 48 小时。',
        claims: [{ text: '经实验室测试可连续防水 48 小时', targetEvidenceIds: [] }],
        assetUses: [],
      },
    }))

    expect(result.allowed).toBe(false)
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'COMPETITOR_UNVERIFIED_FACT_TRANSFER', field: 'candidate.claims[0]' }))
    expect(result.allowedInsights).toEqual({ structures: [], themes: [], trends: [] })
  })

  it('allows public structural learning and does not flag simple public phrases', () => {
    const result = evaluateCompetitorReferencePolicy(baseInput({
      extracted: {
        structures: ['痛点提问→参数证据→适用边界→CTA'],
        themes: ['先说明限制再呈现收益'],
        trends: ['用规格卡片支持移动端扫读'],
        sellingPoints: [],
        originalSpans: [{ text: '立即购买' }, { text: 'Shop now' }, { text: 'ＳＨＯＰ\u200b NOW！' }],
        assets: [],
      },
      candidate: { title: '通勤外套', body: '先列出经本商家确认的参数，再说明适用边界。立即购买。', claims: [], assetUses: [] },
    }))

    expect(result).toMatchObject({ allowed: true, findings: [], humanReview: { required: false } })
    expect(result.allowedInsights).toEqual({
      structures: ['痛点提问→参数证据→适用边界→CTA'],
      themes: ['先说明限制再呈现收益'],
      trends: ['用规格卡片支持移动端扫读'],
    })
    expect(result.provenance).toMatchObject({ complete: true, url: 'https://example.com/public-campaign', platform: 'tmall', accessKind: 'public' })
  })

  it('blocks cross-workspace private material and competitor asset appropriation', () => {
    const result = evaluateCompetitorReferencePolicy(baseInput({
      reference: {
        url: 'https://private.example/reference', platform: 'private-library', fetchedAt: '2026-08-28T08:00:00.000Z',
        access: { kind: 'private', evidence: 'Internal library', ownerWorkspaceId: 'ws_foreign' },
      },
      extracted: {
        structures: ['故事化首屏'], themes: [], trends: [], sellingPoints: [], originalSpans: [],
        assets: [
          { id: 'competitor-logo', kind: 'logo', description: '竞品 Logo' },
          { id: 'competitor-mark', kind: 'trademark', description: '竞品商标' },
          { id: 'competitor-person', kind: 'person', description: '竞品人物素材' },
          { id: 'competitor-image', kind: 'image', description: '竞品商品图' },
        ],
      },
      candidate: { body: '使用参考图制作主图。', claims: [], assetUses: [
        { sourceAssetId: 'competitor-logo', kind: 'logo' },
        { sourceAssetId: 'competitor-mark', kind: 'trademark' },
        { sourceAssetId: 'competitor-person', kind: 'person' },
        { sourceAssetId: 'competitor-image', kind: 'image' },
      ] },
    }))

    expect(result.allowed).toBe(false)
    expect(result.findings.map(item => item.code)).toEqual(expect.arrayContaining(['COMPETITOR_CROSS_TENANT_PRIVATE_SOURCE', 'COMPETITOR_ASSET_REUSE']))
    expect(result.findings.filter(item => item.code === 'COMPETITOR_ASSET_REUSE')).toHaveLength(4)
    expect(result.allowedInsights).toEqual({ structures: [], themes: [], trends: [] })
  })

  it('fails closed when URL, fetch time, or public/authorization evidence is missing', () => {
    const result = evaluateCompetitorReferencePolicy(baseInput({
      reference: { url: '', platform: 'web', fetchedAt: '', access: { kind: 'public', evidence: '' } },
    }))

    expect(result.allowed).toBe(false)
    expect(result.findings.map(item => item.code)).toEqual(expect.arrayContaining([
      'COMPETITOR_SOURCE_URL_REQUIRED',
      'COMPETITOR_FETCH_TIME_REQUIRED',
      'COMPETITOR_ACCESS_EVIDENCE_REQUIRED',
    ]))
    expect(result.provenance.complete).toBe(false)
    expect(result.humanReview.required).toBe(true)
  })

  it('passes a fully sourced reference when candidate facts are independently proven', () => {
    const result = evaluateCompetitorReferencePolicy(baseInput({
      extracted: {
        structures: ['规格对比→使用建议'], themes: ['透明说明适用范围'], trends: ['参数卡片'], originalSpans: [], assets: [],
        sellingPoints: [{ text: 'UPF50+ 防晒' }],
      },
      candidate: {
        body: '本商品为 UPF50+ 防晒，依据本店检测报告呈现。',
        claims: [{ text: 'UPF50+ 防晒', targetEvidenceIds: ['asset:local-upf-report:r3'] }],
        assetUses: [],
      },
    }))

    expect(result.allowed).toBe(true)
    expect(result.findings).toEqual([])
    expect(result.removedSpans).toEqual([])
    expect(result.humanReview).toMatchObject({ required: false, reasons: [] })
  })
})
