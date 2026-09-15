import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { alertNotificationReadiness, notifyOperationalAlert } from './alert-notifier.js'
import type { OperationalAlert } from '../../../packages/persistence/src/index.js'

const alert: OperationalAlert = {
  id: 'alert_1', workspaceId: 'ws_notify', alertKey: 'oauth:taobao:store:revoked', code: 'OAUTH_REAUTH_REQUIRED', severity: 'high', platform: 'taobao', accountId: 'store', entityType: 'platform_account', entityId: 'store', title: '需要重新授权', status: 'open', observedAt: '2026-08-26T00:00:00.000Z', evidence: { token_state: 'revoked' }, nextAction: '重新授权', updatedAt: '2026-08-26T00:00:00.000Z',
}

describe('alert notifier', () => {
  it('reads the signing secret from a non-symlink file and fails closed for invalid file configuration', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'merchant-alert-secret-'))
    const secretFile = join(directory, 'hmac')
    const secretLink = join(directory, 'hmac-link')
    writeFileSync(secretFile, 'file-secret\n', { mode: 0o600 })
    symlinkSync(secretFile, secretLink)
    const base = { NODE_ENV: 'production', OPS_ALERT_NOTIFICATIONS_ENABLED: 'true', OPS_ALERT_WEBHOOK_URL: 'https://alerts.test/hook', OPS_ALERT_WEBHOOK_ALLOWED_HOSTS: 'alerts.test' }
    try {
      expect(alertNotificationReadiness({ ...base, OPS_ALERT_WEBHOOK_SECRET_FILE: secretFile })).toMatchObject({ ready: true })
      expect(alertNotificationReadiness({ ...base, OPS_ALERT_WEBHOOK_SECRET: 'direct', OPS_ALERT_WEBHOOK_SECRET_FILE: secretFile })).toMatchObject({ ready: false, reason: expect.stringContaining('不能同时配置') })
      expect(alertNotificationReadiness({ ...base, OPS_ALERT_WEBHOOK_SECRET_FILE: join(directory, 'missing') })).toMatchObject({ ready: false, reason: 'OPS_ALERT_WEBHOOK_SECRET_FILE 不可读取' })
      expect(alertNotificationReadiness({ ...base, OPS_ALERT_WEBHOOK_SECRET_FILE: secretLink })).toMatchObject({ ready: false, reason: 'OPS_ALERT_WEBHOOK_SECRET_FILE 不能是符号链接' })
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 202 }))
      await expect(notifyOperationalAlert(alert, { env: { ...base, OPS_ALERT_WEBHOOK_SECRET_FILE: secretFile }, fetchImpl, now: () => 1_756_089_600_000, requestId: 'notify_file' })).resolves.toMatchObject({ delivery: 'delivered' })
      expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ 'x-merchant-alert-signature': expect.stringMatching(/^sha256=[a-f0-9]{64}$/u) })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails closed when the channel is not configured or is insecure in production', () => {
    expect(alertNotificationReadiness({ NODE_ENV: 'production' })).toMatchObject({ configured: false, ready: false })
    expect(alertNotificationReadiness({ NODE_ENV: 'production', OPS_ALERT_NOTIFICATIONS_ENABLED: 'invalid' })).toMatchObject({ configured: false, ready: false })
    expect(alertNotificationReadiness({ NODE_ENV: 'production', OPS_ALERT_NOTIFICATIONS_ENABLED: 'true', OPS_ALERT_WEBHOOK_URL: 'http://alerts.test', OPS_ALERT_WEBHOOK_SECRET: 'secret' })).toMatchObject({ configured: true, ready: false })
    expect(alertNotificationReadiness({ NODE_ENV: 'production', OPS_ALERT_NOTIFICATIONS_ENABLED: 'true', OPS_ALERT_WEBHOOK_URL: 'https://alerts.test/hook', OPS_ALERT_WEBHOOK_SECRET: 'secret' })).toMatchObject({ configured: true, ready: false, reason: '安全环境必须配置 OPS_ALERT_WEBHOOK_ALLOWED_HOSTS' })
    expect(alertNotificationReadiness({ NODE_ENV: 'production', OPS_ALERT_NOTIFICATIONS_ENABLED: 'true', OPS_ALERT_WEBHOOK_URL: 'https://127.0.0.1/hook', OPS_ALERT_WEBHOOK_ALLOWED_HOSTS: '127.0.0.1', OPS_ALERT_WEBHOOK_SECRET: 'secret' })).toMatchObject({ configured: true, ready: false })
  })

  it('allows an explicit notification opt-out without requiring webhook credentials', async () => {
    const env = { NODE_ENV: 'production', OPS_ALERT_NOTIFICATIONS_ENABLED: 'false' }
    expect(alertNotificationReadiness(env)).toEqual({ enabled: false, configured: false, ready: true })
    await expect(notifyOperationalAlert(alert, { env })).resolves.toEqual({ delivery: 'disabled', attempts: 0, reason: undefined })
  })

  it('blocks delivery when notification configuration is missing or invalid', async () => {
    await expect(notifyOperationalAlert(alert, { env: { NODE_ENV: 'production' } })).resolves.toMatchObject({ delivery: 'blocked', attempts: 0 })
    await expect(notifyOperationalAlert(alert, { env: { NODE_ENV: 'production', OPS_ALERT_NOTIFICATIONS_ENABLED: 'invalid' } })).resolves.toMatchObject({ delivery: 'blocked', attempts: 0 })
  })

  it('signs a sanitized alert and retries transient webhook failures', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('{}', { status: 202 }))
    const result = await notifyOperationalAlert(alert, { env: { NODE_ENV: 'production', OPS_ALERT_NOTIFICATIONS_ENABLED: 'true', OPS_ALERT_WEBHOOK_URL: 'https://alerts.test/hook', OPS_ALERT_WEBHOOK_ALLOWED_HOSTS: 'alerts.test', OPS_ALERT_WEBHOOK_SECRET: 'secret' }, fetchImpl, now: () => 1_756_089_600_000, requestId: 'notify_test' })
    expect(result).toMatchObject({ delivery: 'delivered', attempts: 3, requestId: 'notify_test' })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    const request = fetchImpl.mock.calls[2]?.[1] as RequestInit
    expect(request.headers).toMatchObject({ 'x-merchant-alert-signature': expect.stringMatching(/^sha256=[a-f0-9]{64}$/u), 'x-request-id': 'notify_test' })
    expect(JSON.parse(String(request.body))).toMatchObject({ type: 'merchant.operation_alert', alert: { workspace_id: 'ws_notify', code: 'OAUTH_REAUTH_REQUIRED' } })
  })
})
