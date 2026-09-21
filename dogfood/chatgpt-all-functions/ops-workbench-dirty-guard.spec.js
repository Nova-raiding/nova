import { expect, test } from '@playwright/test'

test.setTimeout(120_000)
test.use({ channel: 'chrome' })

const baseUrl = process.env.OPS_BASE_URL ?? 'http://127.0.0.1:18082/'

test('keeps a dirty desktop form when browser history targets the unavailable merchant workbench', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(() => {
    localStorage.setItem('ops_workspace_id', 'ws_demo')
    localStorage.setItem('ops_actor_id', 'ops-dirty-guard-qa')
    localStorage.setItem('ops_api_token', 'ops-dirty-guard-local-token')
    localStorage.setItem('ops_workbench', 'platform')
  })
  await page.route('**/api/mcp', async route => {
    const body = route.request().postDataJSON?.() ?? {}
    const workbench = await route.request().headerValue('x-ops-workbench') ?? 'platform'
    if (body.method === 'ops.session') {
      const capabilities = ['platform.summary.read', 'identity.read', 'workspace.directory.read', 'customer.delivery.read', 'customer.delivery.update']
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        jsonrpc: '2.0', id: body.id ?? 'dirty-guard', result: {
          actor_id: 'ops-dirty-guard-qa', workspace_id: 'ws_demo', roles: ['rules_admin'], canonical_roles: ['rules_admin'],
          workspace_granted: true, workbench, available_workbenches: ['platform', 'workspace'],
          scope: { type: workbench === 'platform' ? 'platform' : 'workspace', ...(workbench === 'workspace' ? { id: 'ws_demo' } : {}) },
          scopes: [{ type: workbench === 'platform' ? 'platform' : 'workspace', ids: workbench === 'platform' ? ['*'] : ['ws_demo'] }],
          capabilities, effective_permissions: capabilities.map(capability => ({ capability, effect: 'allow', scope: workbench === 'platform' ? { type: 'platform', ids: ['*'] } : { type: 'workspace', ids: ['ws_demo'] }, source: 'role' })),
          policy_version: 'ops-dirty-guard-local', schema_version: 2, context_id: `ctx-${workbench}`, context_version: '1',
        },
      }) })
      return
    }
    if (body.method === 'ops.workspaces.list') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        jsonrpc: '2.0', id: body.id ?? 'dirty-guard', result: {
          items: [{ workspaceId: 'ws_demo', enterpriseName: '演示商家', status: 'active', planName: '演示套餐', subscriptionStatus: 'active', monthlyPriceCny: 0, memberCount: 1 }],
          total: 1, offset: 0, limit: 20, hasMore: false,
        },
      }) })
      return
    }
    if (body.method === 'ops.customer-delivery.list') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 'dirty-guard', result: [] }) })
      return
    }
    const result = body.method === 'ops.feature-flags.list' ? { items: [] } : []
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 'dirty-guard', result }) })
  })

  await page.goto(new URL('/ops/customer-delivery?workbench=platform', baseUrl).toString(), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('region', { name: '当前身份与权限范围' })).toContainText('已由服务端验证', { timeout: 30_000 })
  const workspace = page.getByLabel('客户交付目标企业工作区')
  await workspace.click()
  await workspace.press('ArrowDown')
  await workspace.press('Enter')
  await expect(page.getByRole('button', { name: /刷新交付档案/u })).not.toHaveClass(/ant-btn-loading/u)
  await page.getByRole('button', { name: '新建客户', exact: true }).click()
  const companyName = page.getByLabel('公司名称').last()
  await companyName.fill('未保存的演示客户')
  // Registration is effect-driven; wait one paint so the controller sees the
  // dirty label before the synthetic history transition fires.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

  const attemptWorkspaceSwitch = async () => {
    const current = page.url()
    await page.evaluate(({ currentUrl }) => {
      window.history.replaceState(null, '', '/ops/rules?workbench=workspace')
      window.history.pushState(null, '', currentUrl)
    }, { currentUrl: current })
    await page.goBack()
  }
  await attemptWorkspaceSwitch()
  await expect(page).toHaveURL(/\/ops\/customer-delivery\?workbench=platform$/u)
  await expect(companyName).toHaveValue('未保存的演示客户')
})
