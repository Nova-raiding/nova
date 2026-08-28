import { describe, expect, it, vi } from 'vitest'
import { alertNotificationReadiness, notifyOperationalAlert } from './alert-notifier.js'
import type { OperationalAlert } from '../../../packages/persistence/src/index.js'

const alert: OperationalAlert = {
  id: 'alert_1', workspaceId: 'ws_notify', alertKey: 'oauth:taobao:store:revoked', code: 'OAUTH_REAUTH_REQUIRED', severity: 'high', platform: 'taobao', accountId: 'store', entityType: 'platform_account', entityId: 'store', title: '需要重新授权', status: 'open', observedAt: '2026-08-26T00:00:00.000Z', evidence: { token_state: 'revoked' }, nextAction: '重新授权', updatedAt: '2026-08-26T00:00:00.000Z',
}

describe('alert notifier', () => {
  it('fails closed when the channel is not configured or is insecure in production', () => {
    expect(alertNotificationReadiness({ NODE_ENV: 'production' })).toMatchObject({ configured: false, ready: false })
    expect(alertNotificationReadiness({ NODE_ENV: 'production', OPS_ALERT_WEBHOOK_URL: 'http://alerts.test', OPS_ALERT_WEBHOOK_SECRET: 'secret' })).toMatchObject({ configured: true, ready: false })
  })

  it('signs a sanitized alert and retries transient webhook failures', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('{}', { status: 202 }))
    const result = await notifyOperationalAlert(alert, { env: { NODE_ENV: 'production', OPS_ALERT_WEBHOOK_URL: 'https://alerts.test/hook', OPS_ALERT_WEBHOOK_SECRET: 'secret' }, fetchImpl, now: () => 1_756_089_600_000, requestId: 'notify_test' })
    expect(result).toMatchObject({ delivery: 'delivered', attempts: 3, requestId: 'notify_test' })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    const request = fetchImpl.mock.calls[2]?.[1] as RequestInit
    expect(request.headers).toMatchObject({ 'x-merchant-alert-signature': expect.stringMatching(/^sha256=[a-f0-9]{64}$/u), 'x-request-id': 'notify_test' })
    expect(JSON.parse(String(request.body))).toMatchObject({ type: 'merchant.operation_alert', alert: { workspace_id: 'ws_notify', code: 'OAUTH_REAUTH_REQUIRED' } })
  })
})
