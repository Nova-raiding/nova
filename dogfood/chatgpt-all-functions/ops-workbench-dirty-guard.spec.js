import { expect, test } from '@playwright/test'

test.setTimeout(120_000)
test.use({ channel: 'chrome' })

const baseUrl = process.env.OPS_BASE_URL ?? 'http://127.0.0.1:18082/'

test('keeps a dirty desktop form until workbench switch is confirmed', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(() => {
    localStorage.setItem('ops_workspace_id', 'ws_demo')
    localStorage.setItem('ops_actor_id', 'ops-dirty-guard-qa')
    localStorage.setItem('ops_api_token', 'ops-dirty-guard-local-token')
    localStorage.setItem('ops_workbench', 'workspace')
  })
  await page.route('**/api/mcp', async route => {
    const body = route.request().postDataJSON?.() ?? {}
    const workbench = await route.request().headerValue('x-ops-workbench') ?? 'platform'
    if (body.method === 'ops.session') {
      const capabilities = ['platform.summary.read', 'feature_flag.read', 'feature_flag.update', 'rule.read', 'rule.update', 'rule.publish.approve']
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
    const result = body.method === 'ops.feature-flags.list' ? { items: [] } : []
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 'dirty-guard', result }) })
  })

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: '总览' })).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: '平台规则', exact: true }).click()
  await expect(page.getByRole('heading', { name: '平台规则' })).toBeVisible({ timeout: 20_000 })
  const draft = page.getByRole('form', { name: '创建规则草稿' })
  await draft.getByLabel('规则包 ID').fill('dirty_guard_demo')

  await page.getByText('平台控制台', { exact: true }).click()
  const warning = page.getByRole('dialog', { name: '放弃未保存内容并切换工作台？' })
  await expect(warning).toBeVisible()
  await warning.getByRole('button', { name: '继续编辑' }).click()
  await expect(warning).toBeHidden()
  await expect(draft.getByLabel('规则包 ID')).toHaveValue('dirty_guard_demo')

  await page.getByRole('button', { name: '功能开关', exact: true }).click()
  await expect(warning).toBeVisible()
  await expect(page.getByRole('heading', { name: '平台规则' })).toBeVisible()
  await expect(draft.getByLabel('规则包 ID')).toHaveValue('dirty_guard_demo')
  await warning.getByRole('button', { name: '继续编辑' }).click()

  const currentUrl = page.url()
  await page.evaluate(({ current }) => {
    window.history.replaceState(null, '', '/ops/feature-flags?workbench=platform')
    window.history.pushState(null, '', current)
  }, { current: currentUrl })
  await page.goBack()
  await expect(warning).toBeVisible()
  await expect(page.getByRole('heading', { name: '平台规则' })).toBeVisible()
  await expect(draft.getByLabel('规则包 ID')).toHaveValue('dirty_guard_demo')
  await warning.getByRole('button', { name: '继续编辑' }).click()
  await expect(page).toHaveURL(/\/ops\/rules\?workbench=workspace$/u)

  await page.getByText('平台控制台', { exact: true }).click()
  await expect(warning).toBeVisible()
  await warning.getByRole('button', { name: '放弃并切换' }).click()
  await expect(page).toHaveURL(/workbench=platform/u)
  await expect(page.getByRole('form', { name: '创建规则草稿' }).getByLabel('规则包 ID')).toHaveValue('')
  await expect(page.getByRole('radio', { name: '平台控制台' })).toBeChecked({ timeout: 20_000 })
})
