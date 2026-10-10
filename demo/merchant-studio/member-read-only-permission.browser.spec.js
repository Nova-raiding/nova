import { expect, test } from '@playwright/test'

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4188'
const workspaceId = 'ws_member_read_only_fixture'

test.setTimeout(60_000)
test.use({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' })

const envelope = (workspace, data) => ({
  request_id: 'member-read-only-fixture',
  trace_id: 'member-read-only-fixture',
  workspace_id: workspace,
  data,
  warnings: [],
  next_actions: [],
  error: null,
})

async function chooseWorkspace(page) {
  const label = '选择当前商家工作区 ID'
  const selector = page.getByRole('combobox', { name: label, exact: true })
  await expect(selector).toBeVisible()
  const selectRoot = selector.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select ")]')
  await selectRoot.locator('.ant-select-content').click({ force: true })
  await expect(selector).toHaveAttribute('aria-expanded', 'true')
  await selector.press('Home')
  await selector.press('Enter')
  await expect(page.locator('.app-shell')).toBeVisible()
}

test('成员读取权限不显示邀请与治理写操作，也不发送写请求', async ({ page }) => {
  const mcpMethods = []
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))

  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/api/u, '')
    let data = { items: [], total: 0, limit: 50, offset: 0 }

    if (path === '/v1/auth/session') {
      data = { account: { id: 'member-reader', login: 'reader@example.invalid', accountType: 'merchant', status: 'active', workspaceIds: [workspaceId, 'ws_member_read_only_other'] } }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(null, data)) })
    }
    if (path === '/v1/auth/mcp-token') {
      const targetWorkspace = request.postDataJSON()?.workspace_id ?? workspaceId
      data = { access_token: `token-${targetWorkspace}`, refresh_token: `refresh-${targetWorkspace}`, expires_in: 300, workspace_id: targetWorkspace }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(null, data)) })
    }
    if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(null, data)) })
    }
    if (path === '/mcp') {
      const body = request.postDataJSON()
      const method = body?.method ?? 'unknown'
      mcpMethods.push(method)
      if (method === 'ops.session') data = {
        result: { workspace_id: workspaceId, workbench: 'workspace', capabilities: ['workspace.member.read'], assignable_roles: ['operator'] },
      }
      else if (method === 'ops.members.list') data = {
        result: { items: [{ id: 'member-protected', externalSubject: 'owner@example.invalid', displayName: '受保护的工作区所有者', role: 'workspace_owner', status: 'active', revision: 4, governance: { canChangeTarget: true, canDeactivateTarget: true } }], total: 1, offset: 0, limit: 20, hasMore: false },
      }
      else if (method === 'workspace.metrics') data = { result: { source: 'fixture', stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskSummary: { total: 0, returned: 0, truncated: false }, riskItems: [], taskFunnel: {} } }
      else data = { result: {} }
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(request.headers()['x-workspace-id'] ?? null, data)) })
  })

  await page.goto(`${studioUrl}/merchant/members`, { waitUntil: 'domcontentloaded' })
  await chooseWorkspace(page)
  await page.evaluate(() => {
    window.history.pushState(null, '', '/merchant/members')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })

  const memberTable = page.getByRole('table', { name: '工作区成员列表' })
  await expect(memberTable).toContainText('受保护的工作区所有者', { timeout: 10_000 })
  await expect(memberTable.getByText('仅查看')).toBeVisible()
  await expect(page.getByRole('form', { name: '邀请工作区成员' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '调整 受保护的工作区所有者 的角色' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '停用 受保护的工作区所有者' })).toHaveCount(0)
  expect(mcpMethods).toContain('ops.session')
  expect(mcpMethods).toContain('ops.members.list')
  expect(mcpMethods.filter(method => method === 'ops.member.upsert' || method === 'ops.member.suspend')).toEqual([])
  expect(pageErrors).toEqual([])
})
