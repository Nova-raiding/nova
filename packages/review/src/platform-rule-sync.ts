import type { RulePack } from './rule-center.js'

export type RuleSyncPlatform = 'jd' | 'taobao' | 'tmall' | 'pinduoduo' | 'xiaohongshu' | 'douyin'

export interface PlatformRuleSource {
  platform: RuleSyncPlatform
  label: string
  officialUrl: string
  machineReadable: boolean
}

export interface PlatformRuleSyncStatus {
  platform: RuleSyncPlatform
  label: string
  officialUrl: string
  configured: boolean
  machineReadable: boolean
  latestVersion: string | null
  sourceCheckedAt: string | null
  ageHours: number | null
  stale: boolean
  state: 'ready' | 'stale' | 'not_configured'
  reason: string
}

export const PLATFORM_RULE_SOURCES: readonly PlatformRuleSource[] = [
  { platform: 'jd', label: '京东', officialUrl: 'https://rule.jd.com/rule/ruleDetail.action?ruleId=1249712217973198848', machineReadable: false },
  { platform: 'taobao', label: '淘宝', officialUrl: 'https://developer.alibaba.com/doc/doc.htm?articleId=120797&docType=1&treeId=23', machineReadable: false },
  { platform: 'tmall', label: '天猫', officialUrl: 'https://www.tmall.com/wow/seller/act/guize', machineReadable: false },
  { platform: 'pinduoduo', label: '拼多多', officialUrl: 'https://www.yangkeduo.com/home/help/', machineReadable: false },
  { platform: 'xiaohongshu', label: '小红书', officialUrl: 'https://school.xiaohongshu.com/', machineReadable: false },
  { platform: 'douyin', label: '抖音', officialUrl: 'https://school.jinritemai.com/doudian/web/home', machineReadable: false },
]

function validDate(value: string | undefined): string | null {
  if (!value || Number.isNaN(Date.parse(value))) return null
  return value
}

export function platformRuleSyncStatus(
  rules: readonly RulePack[],
  options: { now?: string; intervalHours?: number; manifestUrl?: string; signingSecretConfigured?: boolean } = {},
): PlatformRuleSyncStatus[] {
  const now = Date.parse(options.now ?? new Date().toISOString())
  const intervalHours = Number.isFinite(options.intervalHours) && (options.intervalHours ?? 0) > 0 ? options.intervalHours! : 168
  const configured = Boolean(options.manifestUrl?.trim()) && options.signingSecretConfigured === true
  return PLATFORM_RULE_SOURCES.map(source => {
    // A manual:// row is a fixture or human draft. It must never make a
    // platform look synced; only a signed-manifest source is eligible here.
    const platformRules = rules.filter(rule => rule.status === 'active' && rule.scope === 'platform' && rule.targetId === source.platform && !rule.source.reference.startsWith('manual://'))
    const latest = [...platformRules].sort((a, b) => Date.parse(b.source.checkedAt) - Date.parse(a.source.checkedAt))[0]
    const checkedAt = validDate(latest?.source.checkedAt)
    const ageHours = checkedAt ? Math.max(0, (now - Date.parse(checkedAt)) / 3_600_000) : null
    const stale = !checkedAt || ageHours === null || ageHours > intervalHours
    // A configured manifest is not sufficient evidence for a platform. If
    // this platform has no imported trusted version, keep the state explicit
    // so every consumer can explain that the platform rule data itself is
    // missing (rather than implying that an old version merely went stale).
    const state = !configured || !latest ? 'not_configured' : stale ? 'stale' : 'ready'
    return {
      platform: source.platform, label: source.label, officialUrl: source.officialUrl,
      configured, machineReadable: source.machineReadable, latestVersion: latest?.version ?? null,
      sourceCheckedAt: checkedAt, ageHours, stale, state,
      reason: !configured
        ? '签名规则清单地址或验签密钥未完整配置，系统不会自动导入平台规则'
        : !latest
          ? `尚未导入可验证的${source.label}平台规则，商户与插件不能消费该平台规则`
          : stale
            ? `规则来源已超过 ${intervalHours} 小时未检查`
            : '规则来源在检查窗口内',
    }
  })
}
