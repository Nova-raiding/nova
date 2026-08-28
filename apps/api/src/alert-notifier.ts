import { createHmac, randomUUID } from 'node:crypto'
import type { OperationalAlert } from '../../../packages/persistence/src/index.js'

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

export function alertNotificationReadiness(env: Record<string, string | undefined> = process.env) {
  const url = configuredUrl(env)
  if (!url) return { configured: false, ready: false, reason: 'OPS_ALERT_WEBHOOK_URL 未配置' }
  let parsed: URL
  try { parsed = new URL(url) } catch { return { configured: true, ready: false, reason: 'OPS_ALERT_WEBHOOK_URL 不是合法 URL' } }
  if (env.NODE_ENV === 'production' && parsed.protocol !== 'https:') return { configured: true, ready: false, reason: '生产告警 Webhook 必须使用 HTTPS' }
  if (!env.OPS_ALERT_WEBHOOK_SECRET?.trim()) return { configured: true, ready: false, reason: 'OPS_ALERT_WEBHOOK_SECRET 未配置' }
  return { configured: true, ready: true, protocol: parsed.protocol }
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
  if (!readiness.configured) return { delivery: 'disabled', attempts: 0, reason: readiness.reason }
  if (!readiness.ready) return { delivery: 'blocked', attempts: 0, reason: readiness.reason }
  const requestId = options.requestId ?? `alert_notify_${randomUUID()}`
  const timestamp = options.now?.() ?? Date.now()
  const body = JSON.stringify(alertNotificationBody(alert, requestId, timestamp))
  const signature = createHmac('sha256', env.OPS_ALERT_WEBHOOK_SECRET!.trim()).update(`${timestamp}.${body}`).digest('hex')
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
