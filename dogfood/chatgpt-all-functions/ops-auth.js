import { expect } from '@playwright/test'

// Platform tests must use the signed operations identity boundary. A merchant
// bearer token must never be promoted to a platform session by the test setup.
export async function openPlatformConsole(page, path = '/') {
  const base = process.env.OPS_OIDC_BASE_URL
  const username = process.env.LOCAL_OIDC_TEST_USERNAME
  const password = process.env.LOCAL_OIDC_TEST_PASSWORD
  if (!base || !username || !password) throw new Error('OPS_OIDC_BASE_URL and local OIDC login credentials are required; run node --import tsx scripts/run-ops-oidc-e2e.ts')
  await page.addInitScript(() => {
    localStorage.removeItem('ops_api_token')
    localStorage.removeItem('ops_actor_id')
    localStorage.removeItem('ops_workspace_id')
    localStorage.setItem('ops_workbench', 'platform')
    sessionStorage.setItem('ops_connection_config_v1', JSON.stringify({ apiBase: '/api', workspaceId: 'ws_demo', workbench: 'platform' }))
    sessionStorage.setItem('ops_workspace_id', 'ws_demo')
    sessionStorage.setItem('ops_workbench', 'platform')
  })
  await page.goto(new URL(path, base).toString(), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('textbox', { name: '运营账号', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '运营账号', exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '安全登录', exact: true }).click()
  try {
    await expect(page.getByRole('region', { name: '当前身份与权限范围' })).toContainText('已由服务端验证', { timeout: 30_000 })
  } catch (error) {
    const trace = await page.evaluate(() => window.__OPS_BOOTSTRAP_TRACE__ ?? [])
    console.error(JSON.stringify({ opsBootstrapTrace: trace }))
    throw error
  }
}
