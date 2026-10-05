import { Table } from 'antd'
import type { CommercialCatalogBenefit, CommercialCatalogItem } from './api'
import { commercialBenefitName, commercialBenefitValue } from './CommercialBenefits'

export function comparisonBenefitValue(benefit: CommercialCatalogBenefit | undefined): string {
  if (!benefit) return '未列入此批准版本'
  return commercialBenefitValue(benefit)
}
export function CommercialPlanComparison({ catalog }: { catalog: CommercialCatalogItem[] }) {
  const monthly = catalog.filter(item => item.type === 'monthly' && item.approval_state === 'approved' && item.executable && item.plan_family && Number.isSafeInteger(item.tier_rank) && item.tier_rank! > 0)
  const families = [...new Set(monthly.map(item => item.plan_family!))]
  const onboarding = catalog.filter(item => item.type === 'onboarding')
  return <section className="commercial-plan-comparison" aria-label="套餐权益对比"><h3>套餐权益对比</h3><p>按已批准并上架的商品逐项比较，价格可调整；功能权限与点数、品牌、店铺、存储额度分别列示。未上架档位不提供购买，尊享额度以批准版本为准。</p>
    {!families.length && <p role="status">尚未读取到身份明确的已批准套餐，当前不能构造三档可购对比。</p>}
    {families.map(family => {
      const offers = [1, 2, 3].map(rank => { const matches = monthly.filter(item => item.plan_family === family && item.tier_rank === rank); return matches.length === 1 ? matches[0] : undefined })
      const codes = [...new Set(offers.flatMap(item => item?.benefits.map(benefit => benefit.code) ?? []))].filter(code => !['grant_count', 'points_per_grant'].includes(code))
      const rows = [
        { key: 'price', label: '套餐费用 / 周期', values: offers.map(item => item ? `${item.price_label} / ${item.cycle_label ?? '周期待核实'}` : '未上架或版本待核实') },
        ...codes.map(code => ({ key: code, label: commercialBenefitName(code), values: offers.map(item => item ? comparisonBenefitValue(item.benefits.find(benefit => benefit.code === code)) : '未上架或版本待核实') })),
      ]
      return <div key={family}><Table rowKey="key" dataSource={rows} pagination={false} scroll={{ x: 760 }} aria-label={`套餐权益对比 ${family}`} columns={[{ title: '权益 / 费用', dataIndex: 'label' }, ...offers.map((item, index) => ({ title: item?.name ?? ['基础版', '成长版', '尊享版'][index], render: (_: unknown, row: typeof rows[number]) => row.values[index] }))]} /><details><summary>查看对比商品版本</summary>{offers.map((item, index) => <p key={index}>{item ? `${item.name} · ${item.sku_code} · 已批准版本 ${item.version}` : `${['基础版', '成长版', '尊享版'][index]}尚无唯一在售版本`}</p>)}</details></div>
    })}
    <p>开通费用与首期套餐分别计费，开通赠点独立于套餐点数；各期赠点按开通订单冻结计划履行，不一次性全部到账。</p>
    {onboarding.map(item => <p key={item.sku_code}>{item.name}：{item.price_label}，不含首期套餐费用。</p>)}
  </section>
}
