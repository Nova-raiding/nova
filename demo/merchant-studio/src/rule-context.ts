import type { PlatformId } from './api.js'

export type RuleContext = { platform: PlatformId | 'all'; label: string }

export type RuleExecutionState = 'executable' | 'unverified' | 'blocked'

/**
 * A library row is evidence only when the server has returned an active rule
 * with a traceable, checked source. Fixture/manual rows must never look like
 * executable merchant knowledge merely because they have a friendly status.
 */
export function resolveRuleExecutionState(rule: Pick<RulePackLike, 'status' | 'source'>): RuleExecutionState {
  if (rule.status !== 'active') return 'blocked'
  const source = rule.source
  if (!source?.reference?.trim() || !source.checkedAt?.trim()) return 'unverified'
  if (source.reference.startsWith('manual://') || ['observed', 'merchant'].includes(source.kind)) return 'unverified'
  return ['official', 'legal_review', 'internal'].includes(source.kind) ? 'executable' : 'unverified'
}

type RulePackLike = {
  status: string
  source?: { kind: string; reference: string; checkedAt: string }
}

export function resolveRuleContext(target?: { platform?: PlatformId; storeName?: string; accountId?: string }): RuleContext {
  if (!target?.platform) return { platform: 'all', label: '全部平台 · 未选择店铺' }
  return { platform: target.platform, label: `${target.platform} · ${target.storeName && target.accountId ? `${target.storeName}（店铺身份已确认）` : '店铺身份待确认'}` }
}
