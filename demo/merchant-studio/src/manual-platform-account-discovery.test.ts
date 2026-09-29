import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isManualPlatformOperationsMode, platformOperationsModeFromHealth, shouldDiscoverPlatformAccounts } from './App'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

describe('manual platform account discovery', () => {
  it('reads operator-registered workspace stores in manual mode without enabling OAuth or sync', () => {
    expect(shouldDiscoverPlatformAccounts('/api', 'manual')).toBe(false)
    expect(isManualPlatformOperationsMode(' MANUAL ')).toBe(true)
    expect(shouldDiscoverPlatformAccounts('/api', ' MANUAL ')).toBe(false)
    expect(app).toContain('fetchPlatformAccounts(baseUrl)')
    expect(app).toContain('登记店铺资料')
    expect(app).toContain('人工登记（未授权）')
    expect(app).toContain('请勿在此输入平台密码、Cookie、Token 或验证码')
    expect(app).not.toContain('前往运营后台登记店铺')
    expect(app).not.toContain('ops.yxsona.com/ops/stores')
    expect(app).toContain('registerManualStoreRecord(baseUrl, selectedPlatform as PlatformId')
    expect(app).toContain("result.connection.token_state !== 'manually_registered'")
    expect(app).toContain("saved.state !== 'manually_registered' || saved.readEnabled || saved.writeEnabled")
    expect(app).toContain('catalogPlatformOrder.map')
    expect(app).toContain('const requestId = ++syncJobsRequestId.current')
    expect(app).toContain('if (!baseUrl) {\n      setSyncJobs(null)')
    expect(app).toContain('if (!shouldDiscoverPlatformAccounts(baseUrl, apiMode)) {\n      setSyncJobs(null)')
    expect(app).toContain('{shouldDiscoverPlatformAccounts(baseUrl, apiMode) && (')
    expect(app).toContain('if (requestId === syncJobsRequestId.current) setSyncJobs(jobs)')
  })

  it('uses setup.platformOperations.mode, never the environment setup.mode', () => {
    const fixtureHealth = { status: 'ok', connectors: {}, setup: { mode: 'fixture', platformOperations: { mode: 'manual' } } }
    const productionHealth = { status: 'ok', connectors: {}, setup: { mode: 'production', platformOperations: { mode: 'manual' } } }
    expect(platformOperationsModeFromHealth(fixtureHealth)).toBe('manual')
    expect(platformOperationsModeFromHealth(productionHealth)).toBe('manual')
    expect(app).toContain('setApiMode(platformOperationsModeFromHealth(healthResult.value))')
    expect(app).not.toContain('return health?.setup?.mode')
  })

  it('reads registered workspace stores even when health has not reported the automation mode', () => {
    expect(shouldDiscoverPlatformAccounts('/api', null)).toBe(false)
    expect(shouldDiscoverPlatformAccounts('/api', undefined)).toBe(false)
    expect(platformOperationsModeFromHealth({ status: 'ok', connectors: {}, setup: {} })).toBeNull()
    expect(app).not.toContain('平台运营模式未确认')
    expect(app).not.toContain('已停止自动发现店铺和读取同步任务')
    const storePage = app.slice(app.indexOf('function StoreCatalogExperience'), app.indexOf('export function MaterialRecycleBinWorkspace'))
    const materialPage = app.slice(app.indexOf('export function Products('), app.indexOf('const materialWorkspaceProps ='))
    expect(storePage).toContain('fetchPlatformAccounts(baseUrl)')
    expect(storePage).not.toContain('if (isManualPlatformOperationsMode(apiMode) || shouldDiscoverPlatformAccounts(baseUrl, apiMode))')
    expect(materialPage).toContain('fetchPlatformAccounts(baseUrl)')
    expect(materialPage).not.toContain('if (!isManualPlatformOperationsMode(apiMode) && !shouldDiscoverPlatformAccounts(baseUrl, apiMode))')
    expect(app).toContain('if (!shouldDiscoverPlatformAccounts(baseUrl, apiMode)) {\n      setSyncJobs(null)')
  })

  it('allows platform automation only for an explicit official_api mode', () => {
    expect(shouldDiscoverPlatformAccounts('/api', 'official_api')).toBe(true)
    expect(shouldDiscoverPlatformAccounts('/api', ' OFFICIAL_API ')).toBe(true)
    for (const mode of ['production', 'fixture', 'demo', 'test', 'local', 'unexpected']) expect(shouldDiscoverPlatformAccounts('/api', mode), mode).toBe(false)
    expect(app).toContain('店铺发现失败：${describeApiError(error)}')
    expect(app).toContain('平台与店铺读取失败：${describeApiError(cause)}')
    expect(app).toContain('店铺发现失败：${describeApiError(cause)}')
  })

  it('does not discover accounts without an API base', () => {
    expect(shouldDiscoverPlatformAccounts(undefined, 'production')).toBe(false)
  })
})
