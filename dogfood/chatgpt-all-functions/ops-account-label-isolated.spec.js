import { expect, test } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openPlatformConsole } from './ops-auth.js'

const workspaceId = process.env.OPS_E2E_WORKSPACE_ID
const outputDir = process.env.OPS_E2E_OUTPUT_DIR
if (!workspaceId || !outputDir) throw new Error('ISOLATED_ACCOUNT_LABEL_RUNNER_REQUIRED')
for (const base of [process.env.OPS_BASE_URL]) {
  const url = new URL(base || '')
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('ACCOUNT_LABEL_REQUIRES_LOOPBACK_FIXTURE')
}

test.use({ channel: 'chrome', viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai', trace: 'off', video: 'off', screenshot: 'off' })
test.describe.configure({ retries: 0 })
test.setTimeout(90_000)

test('platform displays the authenticated login from the authenticated password session', async ({ page }, testInfo) => {
    const evidenceDir = join(outputDir, 'account-label-platform')
    await mkdir(evidenceDir, { recursive: true })
    const expectedLogin = process.env.OPS_TEST_USERNAME
    if (!expectedLogin) throw new Error('ISOLATED_ACCOUNT_LOGIN_REQUIRED')
    const evidence = { status: 'failed', kind: 'real_password_session_login_identity', workbench: 'platform', businessMutations: false, sessionForged: false, credentialsSaved: false }
    try {
      await openPlatformConsole(page, '/ops/customer-delivery?workbench=platform')
      const response = await page.request.post(new URL('/api/mcp', page.url()).toString(), {
        // Browser-supplied display metadata must not override the account
        // identity derived from the authenticated password session.
        headers: { 'x-ops-workbench': 'platform', 'x-workspace-id': workspaceId, 'x-ops-display-login': 'forged-browser-login' },
        data: { jsonrpc: '2.0', id: 'account-label-read', method: 'ops.session', params: {} },
      })
      expect(response.status()).toBe(200)
      const envelope = await response.json()
      const session = envelope.data?.result ?? envelope.result
      expect(session?.actor_id).toBeTruthy()
      expect(session?.account_login).toBe(expectedLogin)
      expect(session?.workbench).toBe('platform')
      const trigger = page.getByRole('button', { name: '打开账号信息', exact: true })
      await expect(trigger.locator('strong')).toHaveAttribute('title', expectedLogin)
      await expect(trigger.locator('strong')).not.toHaveAttribute('title', session.actor_id)
      await trigger.click()
      const panel = page.getByRole('dialog', { name: '账号信息', exact: true })
      await expect(panel).toContainText(expectedLogin)
      await expect(panel).not.toContainText(session.actor_id)
      await trigger.click()
      await page.reload({ waitUntil: 'domcontentloaded' })
      await expect(trigger.locator('strong')).toHaveAttribute('title', expectedLogin)
      await expect(trigger.locator('strong')).not.toHaveAttribute('title', session.actor_id)
      await trigger.click()
      await expect(panel).toContainText(expectedLogin)
      const screenshot = join(evidenceDir, 'account-panel.png')
      await page.screenshot({ path: screenshot, fullPage: true })
      await testInfo.attach('account-panel', { path: screenshot, contentType: 'image/png' })
      evidence.status = 'passed'
      evidence.screenshot = 'account-panel.png'
      evidence.reloadChecked = true
      evidence.forgedBrowserLoginIgnored = true
      evidence.loginMatchesAuthenticatedInput = true
      evidence.nonNfcUnicode = expectedLogin !== expectedLogin.normalize('NFC')
    } finally {
      await writeFile(join(evidenceDir, 'result.json'), JSON.stringify(evidence, null, 2), { mode: 0o600, flag: 'wx' })
    }
  })
