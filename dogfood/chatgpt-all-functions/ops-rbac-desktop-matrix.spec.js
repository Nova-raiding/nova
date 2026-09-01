import { expect, test } from '@playwright/test'

test.setTimeout(120_000)
test.use({ channel: 'chrome' })

const baseUrl = process.env.OPS_BASE_URL ?? 'http://127.0.0.1:18082/'

const sessionFor = (workbench, variant = 'full') => {
  const isControlledSupport = variant === 'controlled-support'
  const capabilities = variant === 'deny'
    ? ['platform.summary.read']
    : variant === 'scope-mismatch'
      ? []
      : ['platform.summary.read', 'workspace.summary.read', 'platform.settings.read', 'store.connection.read']
  return {
    actor_id: 'ops-rbac-desktop-qa',
    workspace_id: 'ws_demo',
    roles: isControlledSupport ? ['support_agent'] : ['platform_ops'],
    canonical_roles: isControlledSupport ? ['support_agent'] : ['platform_ops'],
    workspace_granted: true,
    workbench,
    available_workbenches: ['platform', 'workspace'],
    scope: variant === 'scope-mismatch'
      ? { type: 'workspace', id: 'ws_demo' }
      : isControlledSupport
        ? { type: 'controlled_support', id: 'ws_demo' }
        : { type: workbench === 'platform' ? 'platform' : 'workspace', id: workbench === 'platform' ? undefined : 'ws_demo' },
    capabilities,
    effective_permissions: capabilities.map(capability => ({
      capability,
      effect: 'allow',
      scope: { type: capability.startsWith('workspace.') ? 'workspace' : workbench === 'platform' ? 'platform' : 'workspace', ids: workbench === 'platform' ? [] : ['ws_demo'] },
      source: 'role',
    })),
    policy_version: 'ops-rbac-desktop-local',
    ...(isControlledSupport ? {
      temporary_grants: [{
        id: 'jit-desktop-qa',
        access_mode: 'read',
        workspace_id: 'ws_demo',
        capabilities: ['workspace.summary.read'],
        resource_scope: { type: 'workspace', ids: ['ws_demo'] },
        expires_at: '2099-01-01T00:00:00.000Z',
        max_uses: 5,
        use_count: 0,
        revision: 1,
        authorization_revision: 2,
      }],
    } : {}),
  }
}

const genericResult = (method) => {
  if (method === 'workspace.health') return { status: 'ok' }
  if (method === 'workspace.metrics') return { jobs: {}, stores: [], productSummary: {}, riskSummary: {}, taskFunnel: {} }
  if (method === 'ops.stores.list') return { items: [] }
  if (method === 'ops.brand-units.summary') return { items: [] }
  if (method === 'ops.tasks.summary') return { generationQueueCount: 0, publishQueueCount: 0 }
  if (method === 'ops.marketing.summary') return { generationByState: {} }
  if (method === 'platform.model.status') return { state: 'ready', capabilities: {} }
  return []
}

async function installSessionProjection(page, { initialWorkbench = 'platform', variant = 'full', expireOnReload = false } = {}) {
  let currentVariant = variant
  let sessionCalls = 0
  await page.addInitScript(({ workbench }) => {
    localStorage.setItem('ops_workspace_id', 'ws_demo')
    localStorage.setItem('ops_actor_id', 'ops-rbac-desktop-qa')
    localStorage.setItem('ops_api_token', 'ops-rbac-desktop-local-token')
    localStorage.setItem('ops_workbench', workbench)
  }, { workbench: initialWorkbench })
  await page.route('**/api/mcp', async route => {
    const body = route.request().postDataJSON?.() ?? {}
    const requestedWorkbench = route.request().headerValue('x-ops-workbench') ?? initialWorkbench
    if (body.method === 'ops.session') {
      sessionCalls += 1
      const nextVariant = expireOnReload && sessionCalls > 1 ? 'expired' : currentVariant
      const result = nextVariant === 'expired'
        ? sessionFor(requestedWorkbench, 'full')
        : sessionFor(requestedWorkbench, currentVariant)
      if (nextVariant === 'expired') delete result.temporary_grants
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 'ops-rbac-desktop', result }) })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 'ops-rbac-desktop', result: genericResult(body.method) }) })
  })
  return {
    setVariant: value => { currentVariant = value },
    sessionCalls: () => sessionCalls,
  }
}

test('covers platform and workspace workbenches through keyboard switching', async ({ page }) => {
  await installSessionProjection(page)
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: '运营总览' })).toBeVisible({ timeout: 20_000 })
  const switcher = page.getByRole('radiogroup', { name: '当前运营工作台' }).getByRole('radio', { name: '平台控制台' })
  await expect(page.getByRole('radio', { name: '平台控制台' })).toBeChecked()
  await switcher.focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('radio', { name: '商家工作区' })).toBeChecked({ timeout: 20_000 })
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('radio', { name: '平台控制台' })).toBeChecked({ timeout: 20_000 })
})

test('shows controlled-support scope and exits a JIT grant from the keyboard', async ({ page }) => {
  await installSessionProjection(page, { variant: 'controlled-support', expireOnReload: true })
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('受控支持 · ws_demo', { exact: true })).toBeVisible({ timeout: 20_000 })
  const exit = page.getByRole('button', { name: '退出当前临时授权' })
  await expect(exit).toBeVisible()
  await exit.focus()
  await expect(exit).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(exit).toHaveCount(0)
  await expect(page.getByText('工作区 · ws_demo', { exact: true })).toBeVisible()
})

test('expires a controlled-support JIT grant and removes the action surface', async ({ page }) => {
  await installSessionProjection(page, { variant: 'controlled-support', expireOnReload: true })
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('button', { name: '退出当前临时授权' })).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: '退出当前临时授权' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: '退出当前临时授权' })).toHaveCount(0)
  await expect(page.getByText('授权状态：已由服务端验证', { exact: true })).toBeVisible()
})

test('denies a workspace domain without manufacturing access', async ({ page }) => {
  await installSessionProjection(page, { variant: 'deny', initialWorkbench: 'workspace' })
  await page.goto(new URL('/ops/stores?workbench=workspace', baseUrl).toString(), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: /无权访问/ })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('当前会话在workspace:ws_demo范围内缺少', { exact: false })).toBeVisible()
  const retry = page.getByRole('button', { name: '刷新权限' })
  await expect(retry).toBeVisible()
  await retry.focus()
  await expect(retry).toBeFocused()
})

test('blocks a platform/workspace scope mismatch and keeps the denial keyboard reachable', async ({ page }) => {
  await installSessionProjection(page, { variant: 'scope-mismatch', initialWorkbench: 'platform' })
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: /无权访问/u })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('当前会话在workspace:ws_demo范围内缺少', { exact: false })).toBeVisible()
  const retry = page.getByRole('button', { name: '刷新权限' })
  await retry.focus()
  await expect(retry).toBeFocused()
})
