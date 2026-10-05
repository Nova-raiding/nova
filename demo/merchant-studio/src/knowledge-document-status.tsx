import { useEffect, useState } from 'react'
import { fetchProductKnowledgeAssets, type KnowledgeDocumentIndexSummary, type ProductKnowledgeAsset } from './api'
export function documentIndexStatusLabel(summary?: KnowledgeDocumentIndexSummary): string {
  if (!summary) return '未核验'
  if (summary.truncated) return '汇总不完整'
  if (!Number.isSafeInteger(summary.expiredCount) || summary.expiredCount < 0) return '未核验'
  if (summary.expiredCount > 0) return '文档已过期，需复核'
  if (!Number.isSafeInteger(summary.liveCount) || !Number.isSafeInteger(summary.documentCount) || summary.liveCount < 0 || summary.documentCount < summary.liveCount) return '未核验'
  if (summary.liveCount === 0) return '未关联有效文档'
  if ((summary.counts?.failed ?? 0) > 0) return '索引失败'
  if (summary.reviewRequired > 0) return '待审核或权益确认'
  if (summary.complete === true && summary.reviewRequired === 0 && summary.counts?.ready === summary.liveCount) return '已就绪'
  return '处理中'
}
const requestStateLabels: Record<string, string> = { queued: '已排队', indexing: '处理中', ready: '已就绪', stale: '已过期', failed: '失败', deleted: '已删除' }
const requestStateLabel = (state: string) => requestStateLabels[state] ?? '未核验'
export function ProductKnowledgeRows({ assets }: { assets: ProductKnowledgeAsset[] }) {
  return <>{assets.length ? assets.map(asset => <div key={asset.id}>
    <h3>{asset.name}</h3>
    <p>资料审核：{asset.approvalStatus === 'approved' ? '已审核' : asset.approvalStatus === 'rejected' ? '已拒绝' : '待审核'} · 权益：{asset.rightsStatus === 'cleared' ? '已确认' : asset.rightsStatus === 'restricted' ? '权益受限' : asset.rightsStatus === 'unknown' ? '待核验' : '未核验'}</p>
    <p>资产索引请求：{requestStateLabel(asset.indexState)} · 文档索引：{documentIndexStatusLabel(asset.documentIndexSummary)}</p>
    <p>文档索引就绪不代表内容审核或发布批准。</p>
  </div>) : <p>未返回该商品关联的知识资料，不能视为已审核或已就绪。</p>}</>
}
export function ProductKnowledgeReadback({ baseUrl, productId }: { baseUrl?: string; productId: string }) {
  const [assets, setAssets] = useState<ProductKnowledgeAsset[] | null>(null)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let active = true
    setAssets(null); setError('')
    if (!baseUrl) { setError('尚未配置商家 API，知识状态未核验'); return }
    fetchProductKnowledgeAssets(baseUrl, productId).then(rows => { if (active) setAssets(rows) }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '知识状态读取失败') })
    return () => { active = false }
  }, [baseUrl, productId, refresh])
  return <section aria-label="商品知识资料状态"><h2>知识资料状态</h2>
    {error ? <p role="alert">{error}</p> : assets === null ? <p role="status">知识状态尚未读取</p> : <ProductKnowledgeRows assets={assets} />}
    <button type="button" className="secondary" onClick={() => setRefresh(value => value + 1)}>刷新知识状态</button>
  </section>
}
