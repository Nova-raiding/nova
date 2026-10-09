import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { openPlatformConsole } from './ops-auth.js'
import { assertLoopbackHttpOrigin } from './loopback-origin.js'

const base = process.env.OPS_BASE_URL
const actorId = process.env.OPS_ACTOR_ID
if (!base || !actorId) throw new Error('ISOLATED_OPS_RUNNER_REQUIRED')
assertLoopbackHttpOrigin(base)

test.use({ channel: 'chrome', viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Shanghai' })
test.setTimeout(240_000)

async function mcp(page, method, params, id) {
  const response = await page.evaluate(async ({ method, params, id }) => {
    const result = await fetch('/api/mcp', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-ops-workbench': 'platform' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    })
    return { status: result.status, body: await result.json() }
  }, { method, params, id })
  const { status, body } = response
  return { status, body, result: body.result ?? body.data?.result, error: body.error ?? body.data?.error }
}

test('platform rules_admin uploads Markdown into a non-activated manual-review draft', async ({ page }) => {
  await openPlatformConsole(page, '/ops/overview')

  const granted = await mcp(page, 'ops.authorization.role.assign', {
    subject_identity_id: actorId,
    role: 'rules_admin',
    expected_authorization_revision: '2',
    reason: 'isolated browser acceptance for platform rule Markdown draft upload',
  }, 'grant-rules-admin')
  expect(granted.status).toBe(200)
  expect(granted.error).toBeFalsy()
  expect(granted.result).toMatchObject({ role: 'rules_admin' })

  const session = await mcp(page, 'ops.session', {}, 'rules-admin-session')
  expect(session.status).toBe(200)
  expect(session.error).toBeFalsy()
  expect(session.result.canonical_roles ?? session.result.roles).toContain('rules_admin')
  expect(session.result.capabilities).toEqual(expect.arrayContaining(['rule.read', 'rule.update']))

  const cardId = `PDD-QA-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`
  const packId = `pinduoduo-manual-${cardId.toLowerCase()}`
  const filename = `isolated-${cardId.toLowerCase()}.md`
  const markdown = [
    '# StoreNova 平台规则导入验收',
    '知识库 v1.0.0',
    `## ${cardId}｜隔离浏览器待审核规则`,
    '- 平台：拼多多',
    '- 官方依据：https://www.yangkeduo.com/home/help/',
    '- 商品关键信息不完整时，应先进行人工复核。',
  ].join('\n')

  await page.goto(new URL('/ops/rules?workbench=platform', base).toString(), { waitUntil: 'domcontentloaded' })
  await expect(page.locator('main').getByText('平台规则', { exact: true }).first()).toBeVisible()
  const uploadButton = page.getByRole('button', { name: '上传平台规则（Markdown/ZIP）', exact: true })
  await expect(uploadButton).toBeVisible()
  await expect(uploadButton).toBeEnabled()

  const publishResponse = page.waitForResponse(response => response.url().endsWith('/api/mcp')
    && response.request().postDataJSON()?.method === 'rule.publish')
  const chooser = page.waitForEvent('filechooser')
  await uploadButton.click()
  await (await chooser).setFiles({ name: filename, mimeType: 'text/markdown', buffer: Buffer.from(markdown) })
  const publish = await publishResponse
  expect(publish.status()).toBe(200)
  const publishRequest = publish.request().postDataJSON()
  expect(publishRequest.params).toMatchObject({
    pack_id: packId,
    version: '1.0.0',
    category: 'platform',
    scope: 'platform',
    source_kind: 'internal',
    source_reference: 'https://www.yangkeduo.com/home/help/',
    status: 'draft',
    public_scope: 'platform',
    target_id: 'pinduoduo',
  })
  const publishBody = await publish.json()
  expect(publishBody.error ?? publishBody.data?.error).toBeFalsy()
  expect(publishBody.result ?? publishBody.data?.result).toMatchObject({ status: 'draft', packId, version: '1.0.0' })
  const importSuccess = page.locator('.ant-alert-success').filter({ hasText: '规则草稿导入完成' })
  await expect(importSuccess).toBeVisible()
  await expect(importSuccess).toContainText('成功 1 张')

  const listed = await mcp(page, 'ops.rules.public.drafts.list', { platform: 'pinduoduo', limit: '20' }, 'verify-manual-draft-list')
  expect(listed.status).toBe(200)
  expect(listed.error).toBeFalsy()
  const created = listed.result.items.find(item => item.pack_id === packId)
  expect(created).toMatchObject({
    pack_id: packId,
    version: '1.0.0',
    status: 'draft',
    source: { trust: 'manual_pending_review' },
    checksum_valid: true,
  })

  const detail = await mcp(page, 'ops.rules.public.drafts.get', {
    platform: 'pinduoduo', pack_id: packId, version: '1.0.0',
  }, 'verify-manual-draft-detail')
  expect(detail.status).toBe(200)
  expect(detail.error).toBeFalsy()
  expect(detail.result.rule).toMatchObject({ id: created.id, status: 'draft', source: { trust: 'manual_pending_review' } })
  expect(detail.result.audit.map(event => event.action)).toEqual(['created'])
  expect(detail.result.audit.some(event => event.action === 'activated')).toBe(false)

  // An unauthenticated browser context safely verifies the API boundary
  // without mutating the authorized actor's roles or the created draft.
  const anonymousContext = await page.context().browser().newContext()
  try {
    const anonymous = await anonymousContext.newPage()
    await anonymous.goto(new URL('/ops/overview', base).toString(), { waitUntil: 'domcontentloaded' })
    const deniedRead = await mcp(anonymous, 'ops.rules.public.drafts.list', { platform: 'pinduoduo', limit: '20' }, 'anonymous-rule-list')
    expect([200, 401, 403]).toContain(deniedRead.status)
    expect(deniedRead.error).toBeTruthy()
    expect(deniedRead.result).toBeUndefined()

    const deniedWrite = await mcp(anonymous, 'rule.publish', {
      pack_id: packId, name: 'Unauthenticated rule attempt', version: '1.0.0',
      category: 'platform', scope: 'platform', source_kind: 'internal',
      source_reference: 'https://www.yangkeduo.com/home/help/',
      source_checked_at: new Date().toISOString(), checks_json: '{"forbiddenTerms":[]}',
      reason: 'unauthenticated browser denial check', status: 'draft',
      public_scope: 'platform', target_id: 'pinduoduo',
    }, 'anonymous-rule-publish')
    expect([200, 401, 403]).toContain(deniedWrite.status)
    expect(deniedWrite.error).toBeTruthy()
    expect(deniedWrite.result).toBeUndefined()
  } finally {
    await anonymousContext.close()
  }
})
