import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openPlatformConsole, openWorkspaceConsole } from './ops-auth.js'

const workspaceId = process.env.OPS_E2E_WORKSPACE_ID
const outputDir = process.env.OPS_E2E_OUTPUT_DIR
if (!workspaceId || !outputDir) throw new Error('ISOLATED_ACCOUNT_LABEL_RUNNER_REQUIRED')
for (const base of [process.env.OPS_OIDC_BASE_URL, process.env.OPS_WORKSPACE_OIDC_BASE_URL]) {
  const url = new URL(base || '')
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('ACCOUNT_LABEL_REQUIRES_LOOPBACK_FIXTURE')
}

test.use({ channel: 'chrome', viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai', trace: 'off', video: 'off', screenshot: 'off' })
test.describe.configure({ retries: 0 })
test.setTimeout(90_000)

for (const workbench of ['platform', 'workspace']) {
  test(`${workbench} hides internal subjects when the signed session has no login claim`, async ({ page }, testInfo) => {
    const evidenceDir = join(outputDir, `account-label-${workbench}`)
    await mkdir(evidenceDir, { recursive: true })
    const evidence = { status: 'failed', kind: 'real_signed_oidc_missing_login_claim', workbench, businessMutations: false, sessionForged: false, credentialsSaved: false }
    try {
      if (workbench === 'workspace') await openWorkspaceConsole(page, '/ops/members?workbench=workspace')
      else await openPlatformConsole(page, '/ops/customer-delivery?workbench=platform')
      const response = await page.request.post(new URL('/api/mcp', page.url()).toString(), {
        headers: { 'x-ops-workbench': workbench, 'x-workspace-id': workspaceId },
        data: { jsonrpc: '2.0', id: 'account-label-read', method: 'ops.session', params: {} },
      })
      expect(response.status()).toBe(200)
      const envelope = await response.json()
      const session = envelope.data?.result ?? envelope.result
      expect(session?.actor_id).toBeTruthy()
      expect(session?.account_login).toBeNull()
      expect(session?.workbench).toBe(workbench)
      const trigger = page.getByRole('button', { name: '打开账号信息', exact: true })
      await expect(trigger).toContainText('账号名称未提供')
      await expect(trigger).not.toContainText(session.actor_id)
      if (workbench === 'workspace') {
        await expect(page.getByRole('heading', { name: '成员与权限', exact: true })).toBeVisible()
        const currentAccount = page.locator('.ops-members-page .ant-card').filter({ has: page.getByText('当前账号权限', { exact: true }) }).first()
        await expect(currentAccount).toContainText('当前账号：账号名称未提供')
        await expect(currentAccount).not.toContainText(session.actor_id)
      }
      await trigger.click()
      const panel = page.getByRole('dialog', { name: '账号信息', exact: true })
      await expect(panel).toContainText('账号名称未提供')
      await expect(panel).not.toContainText(session.actor_id)
      await trigger.click()
      await page.reload({ waitUntil: 'domcontentloaded' })
      await expect(trigger).toContainText('账号名称未提供')
      await expect(trigger).not.toContainText(session.actor_id)

      const screenshot = join(evidenceDir, 'account-panel-shot-scraper.png')
      const storyboard = join(evidenceDir, 'storyboard.json')
      await writeFile(storyboard, JSON.stringify({
        url: page.url(), output: join(evidenceDir, 'account-panel.webm'), viewport: { width: 1440, height: 900 },
        javascript: `sessionStorage.setItem('ops_connection_config_v1', ${JSON.stringify(JSON.stringify({ apiBase: '/api', workspaceId, workbench }))}); sessionStorage.setItem('ops_workspace_id', ${JSON.stringify(workspaceId)}); sessionStorage.setItem('ops_workbench', ${JSON.stringify(workbench)});`,
        scenes: [{ name: 'Open verified account identity', open: page.url(), wait_for: '[aria-label="当前身份与权限范围"]:has-text("已由服务端验证")', do: [
          { wait_for: workbench === 'workspace' ? 'h1:has-text("成员与权限")' : 'h1:has-text("客户交付")' },
          ...(workbench === 'workspace' ? [{ wait_for: '.ops-members-page:has-text("当前账号：账号名称未提供")' }] : []),
          { wait_for: '.ops-status-tag:has-text("已登录")' },
          { wait_for: '[aria-label="打开账号信息"]:has-text("账号名称未提供")' },
          { click: '[aria-label="打开账号信息"]' },
          { wait_for: '[role="dialog"][aria-label="账号信息"]:has-text("账号名称未提供")' },
          { pause: 0.5 },
          { screenshot },
        ] }],
      }), { mode: 0o600, flag: 'wx' })
      const installed = join(homedir(), '.local/bin/shot-scraper')
      const authState = await page.context().storageState()
      await new Promise((resolve, reject) => {
        const child = spawn(existsSync(installed) ? installed : 'shot-scraper', ['video', storyboard, '--auth', '/dev/stdin', '--browser', 'chrome', '--timeout', '30000'], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 35_000 })
        child.stdout.resume(); child.stderr.resume()
        child.once('error', () => reject(new Error('ACCOUNT_LABEL_CAPTURE_UNAVAILABLE')))
        child.once('exit', code => code === 0 ? resolve() : reject(new Error('ACCOUNT_LABEL_CAPTURE_FAILED')))
        child.stdin.on('error', () => {})
        child.stdin.end(JSON.stringify(authState))
      })
      await testInfo.attach('account-panel', { path: screenshot, contentType: 'image/png' })
      evidence.status = 'passed'
      evidence.screenshot = 'account-panel-shot-scraper.png'
      evidence.video = 'account-panel.webm'
      evidence.reloadChecked = true
    } finally {
      await writeFile(join(evidenceDir, 'result.json'), JSON.stringify(evidence, null, 2), { mode: 0o600, flag: 'wx' })
    }
  })
}
