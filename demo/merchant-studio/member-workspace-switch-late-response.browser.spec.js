import { expect, test } from '@playwright/test'

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4188'
const workspaces = ['ws_member_race_a', 'ws_member_race_b']
const envelope = (workspace, data) => ({ request_id: 'member-workspace-race', trace_id: 'member-workspace-race', workspace_id: workspace, data, warnings: [], next_actions: [], error: null })

test.setTimeout(60_000)
test.use({ viewport: { width: 1440, height: 1000 } })

test('members page drops A list response that arrives after switching to B', async ({ page }) => {
  let releaseAList
  let aListStartedResolve
  const aListStarted = new Promise(resolve => { aListStartedResolve = resolve })
  const delayedAList = new Promise(resolve => { releaseAList = resolve })
  const memberListWorkspaces = []
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))

  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api/u, '')
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/v1/auth/session') {
      data = { account: { id: 'member-race-account', login: 'race@example.invalid', accountType: 'merchant', status: 'active', workspaceIds: workspaces } }
    } else if (path === '/v1/auth/mcp-token') {
      const target = request.postDataJSON()?.workspace_id ?? workspaces[0]
      data = { access_token: `token-${target}`, refresh_token: `refresh-${target}`, expires_in: 300, workspace_id: target }
    } else if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (path === '/mcp') {
      const { method } = request.postDataJSON()
      const workspace = request.headers()['x-workspace-id'] ?? ''
      if (method === 'ops.session') data = { result: { workspace_id: workspace, workbench: 'workspace', capabilities: ['workspace.member.read'], assignable_roles: [] } }
      else if (method === 'ops.members.list') {
        memberListWorkspaces.push(workspace)
        if (workspace === workspaces[0] && memberListWorkspaces.filter(value => value === workspaces[0]).length === 1) {
          aListStartedResolve()
          await delayedAList
        }
        data = { result: { items: [{ id: `member-${workspace}`, externalSubject: `${workspace}@example.invalid`, displayName: `成员 ${workspace}`, role: 'operator', status: 'active', revision: 1, governance: { canChangeTarget: false, canDeactivateTarget: false } }], total: 1, offset: 0, limit: 20, hasMore: false } }
      } else if (method === 'workspace.metrics') data = { result: { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} } }
      else data = { result: {} }
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(request.headers()['x-workspace-id'] ?? null, data)) })
  })

  await page.goto(`${studioUrl}/merchant/members`, { waitUntil: 'domcontentloaded' })
  const bootstrap = page.getByRole('combobox', { name: '选择当前商家工作区 ID' })
  await expect(bootstrap).toBeVisible()
  await bootstrap.click()
  await page.getByText(`工作区 ID · ${workspaces[0]}`, { exact: true }).last().click()
  await page.evaluate(() => {
    window.history.pushState(null, '', '/merchant/members')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  await aListStarted

  const workspacePicker = page.getByRole('combobox', { name: '按工作区 ID 切换当前商家工作区' })
  await workspacePicker.click()
  await page.getByText(`工作区 ID · ${workspaces[1]}`, { exact: true }).last().click()
  await page.evaluate(() => {
    window.history.pushState(null, '', '/merchant/members')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  const members = page.getByRole('region', { name: '工作区成员管理' })
  await expect(members.getByRole('table', { name: '工作区成员列表' })).toContainText(`成员 ${workspaces[1]}`)
  await expect(members).not.toContainText(`成员 ${workspaces[0]}`)

  releaseAList()
  await expect(members.getByRole('table', { name: '工作区成员列表' })).toContainText(`成员 ${workspaces[1]}`)
  await expect(members).not.toContainText(`成员 ${workspaces[0]}`)
  expect(memberListWorkspaces).toEqual([workspaces[0], workspaces[1]])
  expect(pageErrors).toEqual([])
})
