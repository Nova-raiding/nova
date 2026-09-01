import { expect, test } from '@playwright/test'

test.setTimeout(90_000)
test.use({ channel: 'chrome' })

const apiUrl = process.env.MERCHANT_API_URL ?? 'http://127.0.0.1:8791'
const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:18081/'
const workspaceId = process.env.MERCHANT_WORKSPACE_ID ?? 'ws_demo'

const roles = [
  { name: 'workspace_owner', token: process.env.MERCHANT_OWNER_TOKEN, canWrite: true },
  { name: 'workspace_admin', token: process.env.MERCHANT_ADMIN_TOKEN, canWrite: true },
  { name: 'operator', token: process.env.MERCHANT_OPERATOR_TOKEN, canWrite: true },
  { name: 'reviewer', token: process.env.MERCHANT_REVIEWER_TOKEN, canWrite: false },
  { name: 'viewer', token: process.env.MERCHANT_VIEWER_TOKEN, canWrite: false },
  { name: 'knowledge_reader', token: process.env.MERCHANT_KNOWLEDGE_READER_TOKEN, canWrite: false },
]

const callMcp = async (request, token, method, params = {}) => {
  const response = await request.post(`${apiUrl}/mcp`, {
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-workspace-id': workspaceId,
    },
    data: { jsonrpc: '2.0', id: `${method}-${Date.now()}`, method, params },
  })
  expect(response.ok(), `${method} HTTP response`).toBe(true)
  return response.json()
}

const availableRoles = () => roles.filter(role => role.token)

test('API enforces the merchant workspace role matrix', async ({ request }) => {
  test.skip(availableRoles().length < roles.length, 'requires one real workspace token per merchant role')

  for (const role of roles) {
    const read = await callMcp(request, role.token, 'catalog.search', { scope: 'workspace' })
    expect(read.error, `${role.name} may read workspace catalog`).toBeNull()

    const write = await callMcp(request, role.token, 'catalog.product.update', {
      product_id: 'role-matrix-probe',
      title: '权限矩阵验收探针',
      expected_version: '1',
    })
    if (role.canWrite) {
      expect(write.error?.code, `${role.name} must pass authorization before resource validation`).not.toBe('FORBIDDEN')
    } else {
      expect(write.error?.code, `${role.name} must be denied customer-content writes`).toBe('FORBIDDEN')
    }
  }
})

test('browser merchant workbench preserves role-specific session context', async ({ page }) => {
  test.skip(availableRoles().length < roles.length, 'requires one real workspace token per merchant role')

  let activeToken = roles[0].token
  const observedAuth = []
  await page.route('**/api/**', async route => {
    const headers = { ...route.request().headers(), authorization: `Bearer ${activeToken}`, 'x-workspace-id': workspaceId }
    observedAuth.push(headers.authorization)
    await route.continue({ headers })
  })
  for (const role of roles) {
    activeToken = role.token
    await page.goto(studioUrl, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('body')).toContainText('大麦')
    await expect(page.locator('.environment-banner')).toBeVisible()
    expect(observedAuth.at(-1)).toBe(`Bearer ${role.token}`)
  }
})
