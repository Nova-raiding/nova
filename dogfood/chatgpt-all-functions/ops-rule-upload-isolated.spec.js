import { expect, test } from '@playwright/test'
import { openPlatformConsole } from './ops-auth.js'

const baseUrl = process.env.OPS_BASE_URL
if (!baseUrl || new URL(baseUrl).hostname !== '127.0.0.1') {
  throw new Error('Platform rule upload acceptance requires an isolated loopback Ops fixture')
}

test.use({ channel: 'chrome', trace: 'off', video: 'off', screenshot: 'off' })
test.setTimeout(120_000)

test('uploads an official-source Markdown rule through Ops MCP and leaves it pending approval', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openPlatformConsole(page, '/ops/rules?workbench=platform')

  await expect(page.getByRole('heading', { name: '平台规则' })).toBeVisible()
  const ruleName = `隔离测试规则-${Date.now()}`
  const markdown = [
    '# Store Nova｜拼多多平台规则知识库 v0.1',
    '',
    `## PDD-E2E｜${ruleName}`,
    '- 平台：拼多多',
    '- 官方依据：https://www.yangkeduo.com/home/help',
    '不得发布违反平台规则的商品信息。',
  ].join('\n')

  let publishRequest
  page.on('request', request => {
    const url = new URL(request.url())
    if (request.method() !== 'POST' || url.pathname !== '/api/mcp') return
    let payload
    try { payload = JSON.parse(request.postData() ?? '') } catch { return }
    if (payload.method === 'rule.publish') publishRequest = payload
  })
  const publishResponsePromise = page.waitForResponse(response => {
    if (response.request().method() !== 'POST' || new URL(response.url()).pathname !== '/api/mcp') return false
    try { return JSON.parse(response.request().postData() ?? '').method === 'rule.publish' } catch { return false }
  })

  await page.getByRole('button', { name: '上传平台规则（Markdown/ZIP）' }).first().click()
  await page.locator('input[type="file"]').last().setInputFiles({
    name: '拼多多平台规则.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(markdown),
  })

  const response = await publishResponsePromise
  const publishResponse = await response.json()
  expect(response.ok()).toBeTruthy()
  expect(publishRequest?.params).toMatchObject({
    pack_id: expect.stringMatching(/^pinduoduo-manual-pdd-e2e$/u),
    name: ruleName,
    category: 'platform',
    scope: 'platform',
    source_kind: 'internal',
    source_reference: 'https://www.yangkeduo.com/home/help',
    status: 'draft',
    public_scope: 'platform',
    target_id: 'pinduoduo',
  })
  expect(publishResponse?.error ?? null).toBeNull()

  await expect(page.getByRole('status').filter({ hasText: '规则草稿导入完成' })).toContainText('成功 1 张')
  const draftTable = page.locator('.ant-card').filter({ hasText: '公共平台规则草稿审核' })
  await draftTable.getByRole('button', { name: '刷新草稿', exact: true }).click()
  await expect(draftTable).toContainText(ruleName)
  await expect(draftTable).toContainText('人工待审核')
  await draftTable.getByText(ruleName, { exact: true }).click()
  await expect(page.getByRole('button', { name: '审批并激活', exact: true })).toBeDisabled()
})
