export type P0GoldenFixture = {
  id: string
  name: string
  expectation: string
  expectedP0Signals: string[]
}

/**
 * PRD 17.2's release-blocking golden set. `expectedP0Signals` is empty for a
 * safe path and contains the deterministic gate signal for a risky path.
 */
export const PRD_17_2_P0_GOLDEN_FIXTURES = [
  {
    id: 'normal-detail',
    name: '正常详情页',
    expectation: 'P0 期望：已确认商品事实可生成、审核并批准，关键事实引用覆盖率为 100%。',
    expectedP0Signals: [],
  },
  {
    id: 'no-price',
    name: '无价格',
    expectation: 'P0 期望：未提供价格时不猜测、不生成价格表达，其他已确认事实可安全通过。',
    expectedP0Signals: [],
  },
  {
    id: 'specified-sku',
    name: '指定 SKU',
    expectation: 'P0 期望：任务快照只冻结指定 SKU，不引用其他 SKU 的价格或库存。',
    expectedP0Signals: [],
  },
  {
    id: 'multi-sku-same-price',
    name: '多 SKU 同值',
    expectation: 'P0 期望：多 SKU 价格相同时允许共享促销价，且指定 SKU 快照与审核一致。',
    expectedP0Signals: [],
  },
  {
    id: 'multi-sku-price-conflict',
    name: '多 SKU 冲突',
    expectation: 'P0 期望：多 SKU 价格不同且促销未声明 SKU 作用域时必须阻断。',
    expectedP0Signals: ['PROMOTION_SKU_SCOPE_REQUIRED'],
  },
  {
    id: 'expired-promotion',
    name: '过期活动价',
    expectation: 'P0 期望：过期活动价不得进入制作方案或正式交付。',
    expectedP0Signals: ['PROMOTION_EXPIRED'],
  },
  {
    id: 'unauthorized-image',
    name: '无授权图',
    expectation: 'P0 期望：未通过扫描与商用权益确认的图片不得冻结到生成快照。',
    expectedP0Signals: ['ASSET_NOT_READY'],
  },
  {
    id: 'unproven-selling-point',
    name: '无证明卖点',
    expectation: 'P0 期望：缺少已确认证明的卖点不得被确认为商品事实。',
    expectedP0Signals: ['SELLING_POINT_PROOF_REQUIRED'],
  },
  {
    id: 'expired-rule',
    name: '规则过期',
    expectation: 'P0 期望：已过期但仍激活的规则必须产生阻断问题，不得静默生成。',
    expectedP0Signals: ['RULE_EXPIRED'],
  },
  {
    id: 'modify-and-restore',
    name: '修改与恢复',
    expectation: 'P0 期望：已批准版本不可被覆盖；修改和恢复均创建可追溯新版本并重新审核。',
    expectedP0Signals: [],
  },
] as const satisfies readonly P0GoldenFixture[]
