import { createHash } from 'node:crypto'
import { err, ok, type Result } from './result.js'

export type OnboardingImportOrderState = 'configuring' | 'accepted' | 'rejected' | 'expired'

export interface OnboardingImportWindowInput {
  readonly state: OnboardingImportOrderState
  readonly paidAt: string
  readonly configuringAt: string
  readonly acceptedAt?: string
  readonly now: string
}

export interface OnboardingImportWindow {
  readonly startsAt: string
  readonly endsAt: string
  readonly status: 'not_started' | 'open' | 'closed'
  readonly closeReason?: 'accepted' | 'paid_window_expired' | 'rejected'
}

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000

const parseIso = (value: string, field: string): Result<number> => {
  if (!value.trim()) return err('ONBOARDING_DATE_INVALID', `${field} is required`, { field })
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return err('ONBOARDING_DATE_INVALID', `${field} must be an ISO date`, { field })
  return ok(parsed)
}

/**
 * Resolve the immutable first-import window from the implementation order.
 * The paid 60-day deadline is never extended by a later acceptance.
 */
export const resolveOnboardingImportWindow = (input: OnboardingImportWindowInput): Result<OnboardingImportWindow> => {
  const configuring = parseIso(input.configuringAt, 'configuringAt')
  if (!configuring.ok) return configuring
  const paid = parseIso(input.paidAt, 'paidAt')
  if (!paid.ok) return paid
  const current = parseIso(input.now, 'now')
  if (!current.ok) return current
  if (paid.value < configuring.value) return err('ONBOARDING_WINDOW_INVALID', 'paidAt cannot precede configuringAt')

  const accepted = input.acceptedAt === undefined ? undefined : parseIso(input.acceptedAt, 'acceptedAt')
  if (accepted && !accepted.ok) return accepted
  if (accepted && accepted.value < configuring.value) return err('ONBOARDING_WINDOW_INVALID', 'acceptedAt cannot precede configuringAt')

  const paidDeadline = paid.value + SIXTY_DAYS_MS
  const acceptedDeadline = accepted?.value
  const endsAtMs = Math.min(acceptedDeadline ?? paidDeadline, paidDeadline)
  const startsAt = new Date(configuring.value).toISOString()
  const endsAt = new Date(endsAtMs).toISOString()
  if (input.state === 'rejected') return ok({ startsAt, endsAt, status: 'closed', closeReason: 'rejected' })
  if (current.value < configuring.value) return ok({ startsAt, endsAt, status: 'not_started' })
  if (current.value >= endsAtMs) {
    return ok({ startsAt, endsAt, status: 'closed', closeReason: acceptedDeadline !== undefined && acceptedDeadline <= paidDeadline && acceptedDeadline <= current.value ? 'accepted' : 'paid_window_expired' })
  }
  return ok({ startsAt, endsAt, status: 'open' })
}

const normalizeIdentityPart = (value: string): Result<string> => {
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toUpperCase()
  if (!normalized) return err('CANONICAL_IDENTITY_INVALID', 'canonical identity parts must not be empty')
  return ok(normalized)
}

/** Build the stable, non-reversible identity key required for import idempotency. */
export const buildCanonicalIdentityHash = (input: { jurisdiction: string; registrationType: string; registrationNumber: string }): Result<string> => {
  const parts = [input.jurisdiction, input.registrationType, input.registrationNumber].map(normalizeIdentityPart)
  const invalid = parts.find(part => !part.ok)
  if (invalid && !invalid.ok) return invalid
  const canonical = parts.map(part => (part as { readonly ok: true; readonly value: string }).value).join('|')
  return ok(createHash('sha256').update(canonical, 'utf8').digest('hex'))
}

const STORE_PLATFORM_LABELS: Record<string, string> = {
  淘宝: 'taobao', 天猫: 'tmall', 京东: 'jd', 拼多多: 'pinduoduo', 小红书: 'xiaohongshu', 抖音: 'douyin', 抖音电商: 'douyin', 抖店: 'douyin',
}

export interface StoreLinkCandidate {
  readonly platform: string
  readonly platformLabel: string
  readonly storeName: string
  readonly shopUrl: string
  readonly linkHost: string
  readonly linkState: 'format_verified_identity_unverified'
  readonly authorizationState: 'not_checked'
}

export interface StoreLinkInspection {
  readonly candidates: readonly StoreLinkCandidate[]
  readonly issues: readonly { line: number; code: string; message: string }[]
  readonly requiresUserConfirmation: true
  readonly note: string
}

/** Parse user-supplied shop introductions without fetching URLs or implying OAuth. */
export const inspectStoreLinks = (input: string): StoreLinkInspection => {
  const candidates: StoreLinkCandidate[] = []
  const issues: { line: number; code: string; message: string }[] = []
  const seen = new Set<string>()
  const lines = input.split(/\r?\n/gu).map((value, index) => ({ value: value.trim(), line: index + 1 })).filter(row => row.value)
  if (input.length > 8_192 || lines.length > 60) return { candidates, issues: [{ line: 0, code: 'INPUT_TOO_LONG', message: '一次最多检查 20 家店铺；请分批发送。' }], requiresUserConfirmation: true, note: '链接只用于识别候选店铺；正式连接必须完成平台官方授权。' }
  const triples: { parts: string[]; line: number }[] = []
  for (let index = 0; index < lines.length; index++) {
    const row = lines[index]!
    if (row.value.includes('｜') || row.value.includes('|')) {
      triples.push({ parts: row.value.split(/[｜|]/gu).map(part => part.trim()), line: row.line })
      continue
    }
    const platform = row.value.match(/^平台\s*[:：]\s*(.+)$/u)
    if (platform && lines[index + 1]?.value.match(/^店铺名称\s*[:：]/u) && lines[index + 2]?.value.match(/^店铺链接\s*[:：]/u)) {
      triples.push({ parts: [platform[1]!, lines[index + 1]!.value.replace(/^店铺名称\s*[:：]\s*/u, ''), lines[index + 2]!.value.replace(/^店铺链接\s*[:：]\s*/u, '')], line: row.line })
      index += 2
      continue
    }
    issues.push({ line: row.line, code: 'LINE_FORMAT_INVALID', message: '请按“平台｜店铺名称｜https://店铺首页”填写，每家店铺一行。' })
  }
  for (const triple of triples.slice(0, 20)) {
    const [labelRaw, nameRaw, urlRaw] = triple.parts
    if (triple.parts.length !== 3 || !labelRaw || !nameRaw || !urlRaw) { issues.push({ line: triple.line, code: 'FIELDS_MISSING', message: '平台、店铺名称和店铺首页链接都需要填写。' }); continue }
    const label = labelRaw.normalize('NFKC').trim()
    const platform = STORE_PLATFORM_LABELS[label]
    if (!platform) { issues.push({ line: triple.line, code: 'PLATFORM_UNKNOWN', message: '当前支持淘宝、天猫、京东、拼多多、小红书和抖音电商。' }); continue }
    const name = nameRaw.normalize('NFKC').trim().replace(/\s+/gu, ' ')
    if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/u.test(name)) { issues.push({ line: triple.line, code: 'STORE_NAME_INVALID', message: '店铺名称为空、过长或含不可显示字符。' }); continue }
    let url: URL
    try { url = new URL(urlRaw) } catch { issues.push({ line: triple.line, code: 'SHOP_URL_INVALID', message: '请输入完整的 HTTPS 店铺首页链接。' }); continue }
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || url.port) { issues.push({ line: triple.line, code: 'SHOP_URL_UNSAFE', message: '店铺链接必须是无账号密码、无端口的 HTTPS 地址。' }); continue }
    const safeUrl = new URL(`${url.origin}${url.pathname}`)
    for (const key of ['shop_id', 'shopId', 'id', 'sellerId', 'userId']) {
      const value = url.searchParams.get(key)
      if (value && /^[a-zA-Z0-9_-]{1,64}$/u.test(value)) safeUrl.searchParams.set(key, value)
    }
    const key = `${platform}:${safeUrl.toString()}`
    if (seen.has(key)) { issues.push({ line: triple.line, code: 'DUPLICATE_STORE_LINK', message: '这家店铺的链接在本次输入中重复了。' }); continue }
    seen.add(key)
    candidates.push({ platform, platformLabel: label, storeName: name, shopUrl: safeUrl.toString(), linkHost: safeUrl.hostname, linkState: 'format_verified_identity_unverified', authorizationState: 'not_checked' })
  }
  if (triples.length > 20) issues.push({ line: 0, code: 'TOO_MANY_STORES', message: '一次最多检查 20 家店铺；其余请分批发送。' })
  return { candidates, issues, requiresUserConfirmation: true, note: '已检查链接格式，但未验证店铺身份、平台权限或授权状态；确认后仍须通过官方授权页连接。' }
}
