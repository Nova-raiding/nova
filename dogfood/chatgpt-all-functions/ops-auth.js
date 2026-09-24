import { expect } from '@playwright/test'

// Platform and workspace tests authenticate through the real password-session
// API. A merchant session must never be promoted to a platform role.
export async function openPlatformConsole(page, path = '/', options = {}) {
  const base = process.env.OPS_BASE_URL
  const username = process.env.OPS_TEST_USERNAME
  const password = process.env.OPS_TEST_PASSWORD
  if (!base || !username || !password) throw new Error('OPS_BASE_URL and isolated account/password credentials are required; run node --import tsx scripts/run-ops-password-e2e.ts')
  if (options.workbench === 'workspace') throw new Error('Ops Console is platform-only; workspace browser acceptance belongs to Merchant Studio')
  await page.addInitScript(() => {
    localStorage.removeItem('ops_api_token')
    localStorage.removeItem('ops_actor_id')
    localStorage.removeItem('ops_workspace_id')
    localStorage.setItem('ops_workbench', 'platform')
    localStorage.setItem('ops_connection_config_v1', JSON.stringify({ apiBase: '/api', workspaceId: '', workbench: 'platform' }))
  })
  await page.goto(new URL(path, base).toString(), { waitUntil: 'domcontentloaded' })
  const login = page.getByPlaceholder('例如 ops@example.com')
  await expect(login).toBeVisible({ timeout: 30_000 })
  await login.fill(username)
  await page.getByPlaceholder('请输入平台运营密码').fill(password)
  await page.getByRole('button', { name: '登录平台运营后台', exact: true }).click()
  try {
    await expect(page.getByRole('region', { name: '当前身份与权限范围' })).toContainText('已由服务端验证', { timeout: 30_000 })
  } catch (error) {
    const trace = await page.evaluate(() => window.__OPS_BOOTSTRAP_TRACE__ ?? [])
    console.error(JSON.stringify({ opsBootstrapTrace: trace }))
    throw error
  }
}
