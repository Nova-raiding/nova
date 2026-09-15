import { createHmac, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import type { OperationalAlert } from '../../../packages/persistence/src/index.js'
import { inspectOutboundUrl, isSecureEnvironment } from '../../../packages/connectors/src/outbound-security.js'

export type AlertNotificationDelivery = 'disabled' | 'blocked' | 'delivered' | 'failed'

export interface AlertNotificationResult {
  delivery: AlertNotificationDelivery
  attempts: number
  reason?: string
  requestId?: string
}

export interface AlertNotificationOptions {
  env?: Record<string, string | undefined>
  fetchImpl?: typeof fetch
  now?: () => number
  requestId?: string
}

const configuredUrl = (env: Record<string, string | undefined>) => env.OPS_ALERT_WEBHOOK_URL?.trim() ?? ''
const configuredAllowedHosts = (env: Record<string, string | undefined>) => (env.OPS_ALERT_WEBHOOK_ALLOWED_HOSTS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)

function configuredSecret(env: Record<string, string | undefined>): { secret?: string; reason?: string } {
  const direct = env.OPS_ALERT_WEBHOOK_SECRET?.trim()
  const file = env.OPS_ALERT_WEBHOOK_SECRET_FILE?.trim()
  if (direct && file) return { reason: 'OPS_ALERT_WEBHOOK_SECRET 与 OPS_ALERT_WEBHOOK_SECRET_FILE 不能同时配置' }
  if (file) {
    try {
      if (lstatSync(file).isSymbolicLink()) return { reason: 'OPS_ALERT_WEBHOOK_SECRET_FILE 不能是符号链接' }
      const secret = readFileSync(file, 'utf8').trim()
      return secret ? { secret } : { reason: 'OPS_ALERT_WEBHOOK_SECRET_FILE 为空' }
    } catch {
      return { reason: 'OPS_ALERT_WEBHOOK_SECRET_FILE 不可读取' }
    }
  }
  return direct ? { secret: direct } : { reason: 'OPS_ALERT_WEBHOOK_SECRET 未配置' }
}

export function alertNotificationReadiness(env: Record<string, string | undefined> = process.env) {
  const enabled = env.OPS_ALERT_NOTIFICATIONS_ENABLED?.trim()
  if (enabled === 'false') return { enabled: false, configured: false, ready: true }
  if (enabled && enabled !== 'true') return { enabled: false, configured: false, ready: false, reason: 'OPS_ALERT_NOTIFICATIONS_ENABLED 必须为 true 或 false' }
  const url = configuredUrl(env)
  if (!url) return { enabled: true, configured: false, ready: false, reason: 'OPS_ALERT_WEBHOOK_URL 未配置' }
  let parsed: URL
  try { parsed = new URL(url) } catch { return { enabled: true, configured: true, ready: false, reason: 'OPS_ALERT_WEBHOOK_URL 不是合法 URL' } }
  const allowedHosts = configuredAllowedHosts(env)
  if (isSecureEnvironment(env.NODE_ENV) && !allowedHosts.length) return { enabled: true, configured: true, ready: false, reason: '安全环境必须配置 OPS_ALERT_WEBHOOK_ALLOWED_HOSTS' }
  const outboundReason = inspectOutboundUrl(url, { environment: env.NODE_ENV, ...(allowedHosts.length ? { allowedHosts } : {}) })
  if (outboundReason) return { enabled: true, configured: true, ready: false, reason: `告警 Webhook 地址不安全：${outboundReason}` }
  const secret = configuredSecret(env)
  if (!secret.secret) return { enabled: true, configured: true, ready: false, reason: secret.reason }
  return { enabled: true, configured: true, ready: true, protocol: parsed.protocol }
}

export function alertNotificationBody(alert: OperationalAlert, requestId: string, timestamp: number) {
  return {
    type: 'merchant.operation_alert',
    version: 1,
    request_id: requestId,
    sent_at: new Date(timestamp).toISOString(),
    alert: {
      id: alert.id,
      workspace_id: alert.workspaceId,
      alert_key: alert.alertKey,
      code: alert.code,
      severity: alert.severity,
      ...(alert.platform ? { platform: alert.platform } : {}),
      ...(alert.accountId ? { account_id: alert.accountId } : {}),
      entity_type: alert.entityType,
      entity_id: alert.entityId,
      title: alert.title,
      status: alert.status,
      observed_at: alert.observedAt,
      evidence: alert.evidence,
      next_action: alert.nextAction,
    },
  }
}

export async function notifyOperationalAlert(alert: OperationalAlert, options: AlertNotificationOptions = {}): Promise<AlertNotificationResult> {
  const env = options.env ?? process.env
  const readiness = alertNotificationReadiness(env)
  if (!readiness.ready) return { delivery: 'blocked', attempts: 0, reason: readiness.reason }
  if (!readiness.enabled) return { delivery: 'disabled', attempts: 0, reason: readiness.reason }
  const configured = configuredSecret(env)
  if (!configured.secret) return { delivery: 'blocked', attempts: 0, reason: configured.reason }
  const requestId = options.requestId ?? `alert_notify_${randomUUID()}`
  const timestamp = options.now?.() ?? Date.now()
  const body = JSON.stringify(alertNotificationBody(alert, requestId, timestamp))
  const signature = createHmac('sha256', configured.secret).update(`${timestamp}.${body}`).digest('hex')
  const fetchImpl = options.fetchImpl ?? fetch
  const maxAttempts = 3
  let attempts = 0
  let lastReason = '告警通知投递失败'
  for (; attempts < maxAttempts; attempts += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3_000)
    try {
      const response = await fetchImpl(configuredUrl(env), {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'x-merchant-alert-id': alert.id, 'x-merchant-alert-timestamp': String(timestamp), 'x-merchant-alert-signature': `sha256=${signature}`, 'x-request-id': requestId },
        body,
        signal: controller.signal,
        redirect: 'error',
      })
      if (response.ok) return { delivery: 'delivered', attempts: attempts + 1, requestId }
      lastReason = `告警 Webhook 返回 HTTP ${response.status}`
      if (response.status < 500 && response.status !== 429) break
    } catch (error) {
      lastReason = error instanceof Error ? error.message : '告警 Webhook 请求失败'
    } finally { clearTimeout(timeout) }
  }
  return { delivery: 'failed', attempts, reason: lastReason, requestId }
}
