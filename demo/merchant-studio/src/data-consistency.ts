export type ConsistencyTone = 'green' | 'amber' | 'neutral'

export type ConsistencyItem = { id: string; label: string; status: ConsistencyTone; statusLabel?: string; detail: string; nextStep: string }

export function resolveDataConsistency(input: {
  apiConfigured: boolean
  productsLoaded: boolean
  productCount: number
  accountsLoaded: boolean
  accountsError: boolean
  selectedCount: number
  productsWithIdentity: number
  productsWithAssets: number
  canonicalStatuses?: Array<'verified' | 'legacy_only' | 'conflict' | 'blocked'>
}): ConsistencyItem[] {
  const canonicalStatuses = input.canonicalStatuses ?? []
  const canonicalKnown = input.productsLoaded && canonicalStatuses.length === input.productCount && input.productCount > 0
  const canonicalUnverified = canonicalStatuses.filter(status => status !== 'verified').length
  return [
    { id: 'platform-store', label: '平台 / 店铺', status: input.accountsError ? 'amber' : input.accountsLoaded && input.productsWithIdentity === input.productCount && input.productCount > 0 ? 'green' : 'amber', detail: input.accountsError ? '店铺身份读取失败' : input.accountsLoaded ? `${input.productsWithIdentity} / ${input.productCount} 个商品身份已核对` : '店铺身份读取中', nextStep: input.accountsError ? '重试店铺发现' : '确认平台和店铺身份' },
    { id: 'products', label: '商品', status: canonicalUnverified > 0 || (input.productsLoaded && input.productCount > 0 && !canonicalKnown) ? 'amber' : input.productsLoaded && input.productCount > 0 ? 'green' : 'amber', statusLabel: canonicalUnverified > 0 ? '待标准链核验' : canonicalKnown ? '标准链已验证' : undefined, detail: !input.productsLoaded ? '商品列表尚未读取' : input.productCount === 0 ? '当前范围没有商品' : canonicalUnverified > 0 ? `${canonicalUnverified} 个商品的标准链尚未验证` : canonicalKnown ? `${input.productCount} 个当前范围商品，标准链已验证` : `${input.productCount} 个当前范围商品，标准链结果尚未取得`, nextStep: canonicalUnverified > 0 || !canonicalKnown ? '打开商品关系并完成标准链核验' : '选择要处理的商品' },
    { id: 'batch', label: '批量任务', status: input.apiConfigured && input.selectedCount >= 2 ? 'green' : 'amber', detail: input.selectedCount >= 2 ? `已选择 ${input.selectedCount} 个独立目标` : `已选择 ${input.selectedCount} 个目标`, nextStep: input.apiConfigured && input.selectedCount >= 2 ? '创建任务组后逐个生成' : '至少选择 2 个商品 / 平台 / 店铺' },
    { id: 'assets', label: '素材关系', status: input.productsWithAssets > 0 ? 'green' : 'amber', detail: input.productsWithAssets > 0 ? `${input.productsWithAssets} 个商品返回素材绑定` : '当前未确认素材绑定', nextStep: '打开商品关系逐个确认' },
    { id: 'rules', label: '规则预检', status: 'neutral', detail: '需在任务内容生成后由服务端检查', nextStep: '进入任务并等待规则检查结果' },
    { id: 'publish', label: '发布状态', status: 'neutral', detail: '未有已批准内容，不可判断发布状态', nextStep: '完成生成、审核和二次发布确认' },
  ]
}
