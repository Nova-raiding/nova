import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { documentIndexStatusLabel, ProductKnowledgeRows, ProductKnowledgeReadback } from './knowledge-document-status'
import type { KnowledgeDocumentIndexSummary, ProductKnowledgeAsset } from './api'
const ready: KnowledgeDocumentIndexSummary = { documentCount: 1, liveCount: 1, counts: { ready: 1 }, reviewRequired: 0, expiredCount: 0, truncated: false, complete: true }
describe('document index summary is independent of asset request state', () => {
  it.each([
    [undefined,'未核验'],
    [{...ready,expiredCount:1},'文档已过期，需复核'],
    [{...ready,expiredCount:undefined} as unknown as KnowledgeDocumentIndexSummary,'未核验'],
    [{...ready,truncated:true},'汇总不完整'],
    [{...ready,liveCount:0},'未关联有效文档'],
    [{...ready,counts:{failed:1}},'索引失败'],
    [{...ready,reviewRequired:1},'待审核或权益确认'],
    [{...ready,complete:false,counts:{queued:1}},'处理中'],
    [{...ready,counts:{ready:0}},'处理中'],
    [ready,'已就绪'],
  ] as const)('labels actual document summary: %j', (summary,label) => expect(documentIndexStatusLabel(summary)).toBe(label))
  it('shows queued request alongside ready docs while preserving pending asset review', () => {
    const asset: ProductKnowledgeAsset={id:'a',productId:'p',name:'事实资料',approvalStatus:'pending',rightsStatus:'unknown',indexState:'queued',documentIndexSummary:ready}
    const html=renderToStaticMarkup(createElement(ProductKnowledgeRows,{assets:[asset]}))
    expect(html).toContain('已排队');expect(html).toContain('已就绪');expect(html).toContain('待审核');expect(html).toContain('待核验')
    expect(html).toContain('不代表内容审核或发布批准')
  })
  it('does not claim readiness when API read or product match is absent', () => {
    expect(renderToStaticMarkup(createElement(ProductKnowledgeReadback,{productId:'p'}))).toContain('知识状态尚未读取')
    expect(renderToStaticMarkup(createElement(ProductKnowledgeRows,{assets:[]}))).toContain('不能视为已审核或已就绪')
  })
})
