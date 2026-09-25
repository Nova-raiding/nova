import { DomainError, type MerchantService, type Platform } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'

export function createAutomationPolicyUtils(service: MerchantService, SUPPORTED_PLATFORMS: readonly Platform[]) {
  function automationPolicyKey(workspaceId: string, platform?: Platform, accountId?: string) { return `${workspaceId}:${platform ?? '*'}:${accountId ?? '*'}` }

  function normalizeAutomationTime(value: string | undefined, field: string): string | undefined {
    if (value === undefined || value.trim() === '') return undefined
    const normalized = value.trim()
    if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(normalized)) throw new DomainError('AUTOMATION_WINDOW_INVALID', `${field} 必须是 HH:mm 格式`, 400)
    return normalized
  }

  function automationWindowContains(now: Date, start?: string, end?: string) {
    if (!start && !end) return true
    if (!start || !end) return false
    const current = now.getHours() * 60 + now.getMinutes()
    const toMinutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5))
    const from = toMinutes(start); const until = toMinutes(end)
    if (from === until) return true
    return from < until ? current >= from && current < until : current >= from || current < until
  }

  function nextAutomationWindowStart(now: Date, start?: string, end?: string) {
    if (!start || !end || automationWindowContains(now, start, end)) return now
    const [hours, minutes] = start.split(':').map(Number)
    const next = new Date(now)
    next.setHours(hours!, minutes!, 0, 0)
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
    return next
  }

  function validateAutomationScope(workspaceId: string, platform?: Platform, accountId?: string) {
    if (platform && !SUPPORTED_PLATFORMS.includes(platform)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'platform 无效', 400)
    if (accountId && !platform) throw new DomainError('STORE_PLATFORM_REQUIRED', '使用 account_id 配置店铺自动化时必须同时指定 platform', 400)
    if (platform && accountId) service.getPlatformAccount(workspaceId, accountId, platform)
    return { platform, accountId }
  }

  return { automationPolicyKey, normalizeAutomationTime, automationWindowContains, nextAutomationWindowStart, validateAutomationScope }
}

export function internalAutomationTickAllowed(env: NodeJS.ProcessEnv = process.env) {
  // Merchant-facing scheduled Automations are owned by the Codex App host.
  // Keep the legacy API/Worker scheduler available for tests and explicit
  // operations migrations, but fail closed in production unless the
  // deployment has deliberately enabled that separate internal scheduler.
  const controlledEnvironment = ['staging', 'preview', 'production'].includes(env.NODE_ENV ?? '')
  return !controlledEnvironment || env.MERCHANT_INTERNAL_AUTOMATION_TICK_ENABLED === 'true'
}

