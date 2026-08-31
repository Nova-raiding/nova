import type { PlatformId } from './api.js'

export type RuleContext = { platform: PlatformId | 'all'; label: string }

export function resolveRuleContext(target?: { platform?: PlatformId; storeName?: string; accountId?: string }): RuleContext {
  if (!target?.platform) return { platform: 'all', label: '全部平台 · 未选择店铺' }
  return { platform: target.platform, label: `${target.platform} · ${target.storeName && target.accountId ? `${target.storeName}（店铺身份已确认）` : '店铺身份待确认'}` }
}
