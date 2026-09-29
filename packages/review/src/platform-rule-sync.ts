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
  { platform: 'jd', label: '京东', officialUrl: 'https://rule.jd.com/rule/list.action', machineReadable: false },
  { platform: 'taobao', label: '淘宝', officialUrl: 'https://developer.alibaba.com/doc/doc.htm?articleId=120797&docType=1&treeId=23', machineReadable: false },
  { platform: 'tmall', label: '天猫', officialUrl: 'https://www.tmall.com/wow/seller/act/guize', machineReadable: false },
  { platform: 'pinduoduo', label: '拼多多', officialUrl: 'https://www.yangkeduo.com/home/help/', machineReadable: false },
  { platform: 'xiaohongshu', label: '小红书', officialUrl: 'https://school.xiaohongshu.com/', machineReadable: false },
  { platform: 'douyin', label: '抖音', officialUrl: 'https://school.jinritemai.com/doudian/web/home', machineReadable: false },
]

const PLATFORM_RULE_SOURCE_PATHS: Readonly<Record<RuleSyncPlatform, readonly RegExp[]>> = {
  jd: [/^\/rule\/(?:list|ruleDetail)\.action$/u],
  taobao: [/^\/(?:doc|docs)\//u],
  tmall: [/^\/wow\/seller\/act\/guize(?:\/|$)/u],
  pinduoduo: [/^\/home\/(?:help|food_trade)(?:\/|$)/u],
  xiaohongshu: [/^\/(?:rule|helper|en\/open\/product)(?:\/|$)/u],
  douyin: [/^\/doudian\/(?:web|wap)\/(?:home|rules|article)(?:\/|$)/u],
}

/**
 * Bind an executable rule to a traceable page on the platform's approved
 * official host and path. Query strings are retained because several official
 * article systems use them as stable identifiers; credentials and non-HTTPS
 * URLs are never accepted.
 */
export function isApprovedPlatformRuleSource(platform: RuleSyncPlatform, reference: string): boolean {
  let url: URL
  try { url = new URL(reference) } catch { return false }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false
  const source = PLATFORM_RULE_SOURCES.find(item => item.platform === platform)
  if (!source || url.hostname !== new URL(source.officialUrl).hostname) return false
  return PLATFORM_RULE_SOURCE_PATHS[platform].some(pattern => pattern.test(url.pathname))
}

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
  const manifestConfigured = Boolean(options.manifestUrl?.trim()) && options.signingSecretConfigured === true
  return PLATFORM_RULE_SOURCES.map(source => {
    // Signed rules require the manifest verifier. An approved manual platform
    // rule is a separate, auditable source of usable policy and can satisfy
    // readiness without claiming that the signed-manifest sync is configured.
    // A signed public platform rule carries its platform in `scopeValue`, not
    // `targetId`: `PostgresRuleRepository.listPublic` projects the shared table
    // as `NULL::text AS target_id, platform AS scope_value`. Matching on
    // `targetId` alone therefore never found them, so every platform reported
    // `not_configured` even after a successful signed import — and the
    // production generation preflight 503s on exactly that state. Both fields
    // are the same concept elsewhere in the rule center (`rule-center.ts`,
    // `server.ts`), so accept either.
    const matchingPlatformRules = rules.filter(rule => rule.status === 'active' && rule.scope === 'platform' && (rule.targetId ?? rule.scopeValue) === source.platform)
    const trustedManualRules = matchingPlatformRules.filter(rule => rule.source.kind === 'internal' && isApprovedPlatformRuleSource(source.platform, rule.source.reference) && rule.source.trust === 'verified')
    const verifiedSignedRules = matchingPlatformRules.filter(rule => rule.source.kind === 'official' && rule.source.trust === 'verified' && rule.source.createdBy === 'signed-rule-sync' && isApprovedPlatformRuleSource(source.platform, rule.source.reference))
    const platformRules = manifestConfigured ? [...trustedManualRules, ...verifiedSignedRules] : trustedManualRules
    const latest = [...platformRules].sort((a, b) => Date.parse(b.source.checkedAt) - Date.parse(a.source.checkedAt))[0]
    const configured = manifestConfigured || trustedManualRules.length > 0
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
            : latest.source.kind === 'internal' ? '规则来源由平台运营人工复核并审批' : '规则来源在检查窗口内',
    }
  })
}
