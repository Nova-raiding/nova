import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isManualPlatformOperationsMode, platformOperationsModeFromHealth, shouldDiscoverPlatformAccounts } from './App'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

describe('manual platform account discovery', () => {
  it('does not request platform accounts while the server is in manual mode', () => {
    expect(shouldDiscoverPlatformAccounts('/api', 'manual')).toBe(false)
    expect(isManualPlatformOperationsMode(' MANUAL ')).toBe(true)
    expect(shouldDiscoverPlatformAccounts('/api', ' MANUAL ')).toBe(false)
    expect(app).toContain('首页不会自动发现、授权或同步店铺')
    expect(app).toContain('人工运营模式不执行平台店铺发现')
    expect(app).toContain('const requestId = ++syncJobsRequestId.current')
    expect(app).toContain('if (!baseUrl) {\n      setSyncJobs(null)')
    expect(app).toContain('if (!shouldDiscoverPlatformAccounts(baseUrl, apiMode)) {\n      setSyncJobs(null)')
    expect(app).toContain('{shouldDiscoverPlatformAccounts(baseUrl, apiMode) && (')
    expect(app).toContain('if (requestId === syncJobsRequestId.current) setSyncJobs(jobs)')
  })

  it('uses setup.mode as the platform operations mode, never the health top-level mode', () => {
    const health = { mode: 'fixture', setup: { mode: 'manual' } }
    expect(platformOperationsModeFromHealth(health as never)).toBe('manual')
    expect(app).toContain('setApiMode(platformOperationsModeFromHealth(healthResult.value))')
    expect(app).not.toContain('setApiMode(healthResult.value.mode')
  })

  it('waits for the server mode before deciding whether discovery is allowed', () => {
    expect(shouldDiscoverPlatformAccounts('/api', null)).toBe(false)
    expect(shouldDiscoverPlatformAccounts('/api', undefined)).toBe(false)
    expect(platformOperationsModeFromHealth({ setup: {} } as never)).toBeNull()
    expect(app).toContain('平台运营模式未确认，已停止自动发现店铺和读取同步任务')
  })

  it('keeps real entitlement and permission errors visible outside manual mode', () => {
    for (const mode of ['production', 'fixture', 'demo', 'test', 'local']) {
      expect(shouldDiscoverPlatformAccounts('/api', mode), mode).toBe(true)
    }
    expect(app).toContain('店铺发现失败：${describeApiError(error)}')
    expect(app).toContain('平台与店铺读取失败：${describeApiError(cause)}')
    expect(app).toContain('店铺发现失败：${describeApiError(cause)}')
  })

  it('does not discover accounts without an API base', () => {
    expect(shouldDiscoverPlatformAccounts(undefined, 'production')).toBe(false)
  })
})
