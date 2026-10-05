import { Alert, Table } from 'antd'
import type { CommercialOnboardingGifts, CommercialPurchaseOrder, CreativePointStatementEntry } from './api'

const time = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '尚未确认'
export const giftBatchStatus = (state: string) => ({ scheduled: '待按约定发放', granted: '已发放', expired: '已过期', canceled: '已取消', failed: '发放异常', blocked: '待处置' }[state] ?? '发放状态待核实')
const orderStatus = (state: string) => ({ pending: '待付款', paid: '已支付', failed: '支付失败', closed: '已关闭', refunded: '已退款', reconciliation_required: '待对账' }[state] ?? '订单状态待核实')
const ledgerEvent = (state: string) => ({ granted: '点数发放', grant: '点数发放', reserved: '点数预留', settled: '实际消耗', released: '释放预留', expired: '点数到期', adjusted: '点数调整', adjustment: '点数调整', revoked: '点数回收' }[state] ?? '事件待核实')
export function pointOriginLabel(entry: CreativePointStatementEntry) {
  const origin = entry.commercial_origin
  if (!origin || origin.status !== 'known' || !origin.kind) return '来源尚未核实'
  return ({ onboarding_gift: '开通赠点', subscription_points: '套餐点数', point_pack: '权益包点数', other: '其他已核实来源' }[origin.kind] ?? '来源尚未核实')
}
export function FrozenOnboardingGiftPolicy({ order }: { order: CommercialPurchaseOrder }) {
  if (order.snapshot?.kind !== 'onboarding' && order.purchase_kind !== 'onboarding_once') return null
  const policy = order.snapshot?.onboarding_gift_policy
  const known = policy && Number.isSafeInteger(policy.grant_count) && policy.grant_count > 0 && Number.isSafeInteger(policy.points_per_grant) && policy.points_per_grant > 0 && policy.cadence === 'monthly' && policy.starts_at === 'payment_verified' && policy.grant_expires_at_rule === 'next_monthly_anniversary'
  return <div className="commercial-gift-details" aria-label="冻结开通赠点说明"><strong>开通赠点独立说明</strong>{known ? <p>共 {policy.grant_count} 期，每期 {policy.points_per_grant} 点，共 {policy.grant_count * policy.points_per_grant} 点。首期在真实开通款核验后发放，其余按月周年发放；每期于下个月周年到期。开通赠点不抵扣首期费，不一次性全部到账，升级不重启。</p> : <p role="status">赠点计划尚未核实，当前不能确认每期数量及发放规则；请查询原订单或联系运营。</p>}<details><summary>查看赠点来源</summary><p>来源订单 {order.id} · 冻结版本 {order.sku_version_id}</p></details></div>
}
export function CommercialGiftPlans({ projection }: { projection?: CommercialOnboardingGifts }) {
  const available = projection?.status === 'available' && Array.isArray(projection.plans)
  return <section className="commercial-gift-details" aria-label="开通赠点计划">
    <h3>开通赠点计划</h3><p>赠点与套餐点数独立记录，按原开通约定逐期发放；升级不重启计划。各期发放和有效时间见下表，均为北京时间。</p>
    {!available ? <><Alert type="warning" title="赠点计划尚未读取完整" description="尚未取得可核实的来源及发放计划，当前不判定为没有赠点。" />{Boolean(projection?.blockers?.length) && <details><summary>查看未读取原因</summary><p>{projection!.blockers.join('；')}</p></details>}</> : !projection.plans!.length ? <p role="status">已读取，当前没有开通赠点计划。</p> : projection.plans!.map(plan => <article key={plan.source_order_id}>
      <p><strong>开通赠点</strong> · {orderStatus(plan.source_order_status)}</p>
      <p>{plan.grant_count} 期 × 每期 {plan.points_per_grant} 点，共 {plan.total_points} 点；此为约定总量，不代表全部已到账。每期分别到期，按原约定履行。</p>
      <details><summary>查看赠点来源与合同版本</summary><p>来源订单 {plan.source_order_id} · 冻结版本 {plan.sku_version_id} · 商品 {plan.sku_code}</p><p>政策引用 {typeof plan.policy_ref === 'string' ? plan.policy_ref : JSON.stringify(plan.policy_ref)} · 原始订单状态 {plan.source_order_status}</p></details>
      <Table rowKey="schedule_id" pagination={false} dataSource={[...plan.batches]} scroll={{ x: 760 }} aria-label={`开通赠点批次 ${plan.source_order_id}`} columns={[
        { title: '期次 / 约定点数', render: (_, row) => `第 ${row.sequence} 期 / ${row.points} 点` },
        { title: '约定发放 / 到期', render: (_, row) => <>{time(row.due_at)}<br />到期 {time(row.expires_at)}</> },
        { title: '真实发放状态', render: (_, row) => <>{giftBatchStatus(row.schedule_status)}{row.granted_at && <div>发放记录 {time(row.granted_at)}</div>}{row.expired_by_time && <div>有效窗口已结束</div>}{row.blockers?.length > 0 && <div>此期有待核实事项</div>}</> },
        { title: '详情', render: (_, row) => <details><summary>查看本期记录</summary><p>计划记录 {row.schedule_id} · 原始状态 {row.schedule_status}</p><p>授予 {row.grant_id ?? '未取得授予记录'}</p>{row.expiration_id && <p>到期记录 {row.expiration_id} · {time(row.expired_at)}</p>}{row.blockers?.length > 0 && <p>待核实原因：{row.blockers.join('；')}</p>}</details> },
      ]} />
    </article>)}
  </section>
}

export function CommercialPointLedger({ entries, unavailableMessage, partial = false }: { entries: CreativePointStatementEntry[] | null; unavailableMessage: string; partial?: boolean }) {
  return <section className="commercial-gift-details" aria-label="创意点来源账本"><h3>创意点来源账本</h3><p>开通赠点、套餐点数与独立权益包分别显示真实来源；正数不代表消耗，预留与消费仍以事件记录为准。</p>
    {entries === null ? <Alert type="warning" title="点数来源账本未读取" description={unavailableMessage} /> : <>{partial && <p role="status">仅显示已读取且可识别的流水，当前不是完整账本。</p>}<Table rowKey="id" dataSource={entries} pagination={{ pageSize: 10 }} scroll={{ x: 860 }} locale={{ emptyText: '已读取，暂无创意点流水' }} columns={[
      { title: '来源', render: (_, row) => <>{pointOriginLabel(row)}{row.commercial_origin?.sequence && <div>第 {row.commercial_origin.sequence} 期</div>}</> },
      { title: '事件', dataIndex: 'eventType', render: ledgerEvent }, { title: '点数变动', dataIndex: 'pointsDelta', align: 'right' },
      { title: '发生时间（北京时间）', dataIndex: 'createdAt', render: time },
      { title: '详情', render: (_, row) => <details><summary>查看流水来源</summary><p>来源订单 {row.commercial_origin?.source_order_id ?? '尚未核实'} · 冻结版本 {row.commercial_origin?.sku_version_id ?? '尚未核实'}</p><p>授予来源 {row.commercial_origin?.grant_id ?? row.grantSourceId ?? '尚未核实'} · 原始事件 {row.eventType}</p></details> },
    ]} /></>}
  </section>
}
