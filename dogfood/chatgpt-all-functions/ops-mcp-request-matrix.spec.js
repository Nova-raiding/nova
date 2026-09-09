import { expect, test } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openPlatformConsole, openWorkspaceConsole } from './ops-auth.js'

// This is a real-browser, real-OIDC audit. It deliberately records request
// facts rather than headers, cookies, tokens, or response bodies so the
// evidence can be retained as a scope matrix.
test.setTimeout(240_000)
test.use({ channel: 'chrome', trace: 'off', video: 'off', screenshot: 'off' })

const platformSections = [
  ['总览', '/ops/overview?workbench=platform'],
  ['用户与租户', '/ops/users?workbench=platform'],
  ['平台连接', '/ops/stores?workbench=platform'],
  ['模型服务', '/ops/models?workbench=platform'],
  ['功能开关', '/ops/feature-flags?workbench=platform'],
  ['存储与对账', '/ops/storage?workbench=platform'],
  ['账务与退款', '/ops/finance?workbench=platform'],
  ['审计中心', '/ops/audit?workbench=platform'],
]
const workspaceSections = [
  ['总览', '/ops/overview?workbench=workspace'],
  ['成员与权限', '/ops/members?workbench=workspace'],
  ['客服', '/ops/support?workbench=workspace'],
  ['事故中心', '/ops/incidents?workbench=workspace'],
  ['任务与内容', '/ops/tasks?workbench=workspace'],
  ['知识库', '/ops/knowledge?workbench=workspace'],
  ['平台规则', '/ops/rules?workbench=workspace'],
  ['账务与退款', '/ops/finance?workbench=workspace'],
]

// These are the opposite-boundary methods. Other methods are allowed to be
// domain-specific and are checked by the server response and session scope.
const platformForbidden = new Set([
  'workspace.commercial.get', 'ops.audit.list', 'ops.members.list',
  'canonical.product.consistency', 'billing.model-usage.statement',
  'workspace.health', 'workspace.metrics', 'knowledge.rule.list',
  'knowledge.asset.list', 'knowledge.brand.preference.get',
  'knowledge.learning.list', 'knowledge.competitor.list', 'ops.marketing.queue',
  'automation.policy.get', 'automation.policy.list', 'automation.scan',
])
const workspaceForbidden = new Set([
  'ops.audit.platform.list', 'ops.workspaces.list', 'ops.stores.list',
  'ops.brand-units.summary', 'ops.tasks.summary', 'ops.marketing.summary',
  'ops.model-usage.summary', 'ops.growth.funnel', 'ops.alerts.list',
  'ops.storage.reconciliation.list', 'platform.model.status',
  'ops.commercial.access.summary', 'ops.commercial.offers.list',
  'ops.commercial.addons.list', 'ops.commercial.coupons.list',
  'ops.commercial.rollouts.list', 'ops.finance.search', 'ops.finance.detail',
  'ops.finance.export',
])
const headingByLabel = {
  '总览': '运营总览',
  '用户与租户': '用户与租户',
  '成员与权限': '成员与权限',
  '客服': '客服工作台',
  '事故中心': '事故中心',
  '任务与内容': '任务与内容',
  '知识库': '知识库',
  '平台连接': '平台连接汇总',
  '平台规则': '平台规则',
  '模型服务': '模型服务',
  '功能开关': '功能开关',
  '存储与对账': '存储与对账',
  '账务与退款': '账务与商业配置',
  '审计中心': '审计中心',
}

const json = value => {
  try { return JSON.parse(value) } catch { return undefined }
}

function capture(page, expectedWorkbench) {
  const requests = []
  const pending = new Map()
  const onRequest = request => {
    const url = new URL(request.url())
    if (request.method() !== 'POST' || !url.pathname.endsWith('/api/mcp')) return
    const body = json(request.postData() ?? '') ?? {}
    const entry = {
      at: new Date().toISOString(),
      workbench: request.headers()['x-ops-workbench'] ?? null,
      hasWorkspaceHeader: Boolean(request.headers()['x-workspace-id']),
      method: body.method ?? null,
      params: body.params ?? {},
      status: null,
      errorCode: null,
      resultKeys: null,
      responseShape: null,
      responseReadError: null,
    }
    requests.push(entry)
    pending.set(request, entry)
  }
  const onResponse = async response => {
    const request = response.request()
    const entry = pending.get(request)
    if (!entry) return
    pending.delete(request)
    entry.status = response.status()
    try { await response.finished() } catch {}
    let raw = ''
    try { raw = await response.text() } catch (error) {
      entry.responseReadError = error instanceof Error ? error.name : 'RESPONSE_BODY_UNAVAILABLE'
      return
    }
    const body = json(raw) ?? {}
    const error = body.error ?? body.data?.error
    const result = body.result ?? body.data?.result
    entry.errorCode = error?.code ?? null
    entry.responseShape = error ? 'error' : result === null ? 'null-result' : result === undefined ? 'missing-result' : 'result'
    entry.resultKeys = result && typeof result === 'object' && !Array.isArray(result) ? Object.keys(result).sort() : null
  }
  page.on('request', onRequest)
  page.on('response', onResponse)
  return { requests, stop: () => { page.off('request', onRequest); page.off('response', onResponse) } }
}

async function walk(page, sections) {
  for (const [label, path] of sections) {
    await page.goto(new URL(path, page.url()).toString(), { waitUntil: 'domcontentloaded' })
    // A workspace member can legitimately lack a domain capability. Verify
    // that the route renders the explicit access-denied state instead of
    // treating the absence of a domain page as a browser failure.
    const pageHeading = page.getByRole('heading', { name: headingByLabel[label], exact: true }).first()
    const deniedHeading = page.getByRole('heading', { name: /无权访问/u }).first()
    await expect(pageHeading.or(deniedHeading)).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(2_000)
  }
}

async function writeEvidence(kind, outputDir, captureState, expectedWorkbench) {
  await new Promise(resolve => setTimeout(resolve, 500))
  const requests = captureState.requests
  const violations = requests.flatMap(entry => {
    const errors = []
    if (entry.workbench !== expectedWorkbench) errors.push(`workbench=${entry.workbench ?? 'missing'}`)
    if (expectedWorkbench === 'workspace' && entry.method !== 'ops.session' && !entry.hasWorkspaceHeader) errors.push('workspace header missing')
    if (expectedWorkbench === 'platform' && entry.hasWorkspaceHeader) errors.push('platform request carries workspace header')
    if ((expectedWorkbench === 'platform' ? platformForbidden : workspaceForbidden).has(entry.method)) errors.push('opposite-boundary method')
    if (entry.status >= 400 || entry.errorCode) errors.push(`error=${entry.errorCode ?? entry.status}`)
    if (entry.responseShape === 'missing-result' && !entry.responseReadError) errors.push('successful response missing result')
    return errors.length ? [{ method: entry.method, errors }] : []
  })
  const evidence = {
    schemaVersion: 1,
    evidenceKind: 'real_browser_mcp_workbench_scope_matrix',
    expectedWorkbench,
    requestCount: requests.length,
    methods: [...new Set(requests.map(entry => entry.method))].sort(),
    countsByMethod: Object.fromEntries([...new Set(requests.map(entry => entry.method))].sort().map(method => [method, requests.filter(entry => entry.method === method).length])),
    requests,
    violations,
    capturedHeaders: ['x-ops-workbench', 'x-workspace-id presence only'],
  }
  await mkdir(outputDir, { recursive: true })
  await writeFile(join(outputDir, `ops-mcp-request-matrix-${kind}.json`), JSON.stringify(evidence, null, 2), { mode: 0o600 })
  expect(violations, `${kind} workbench MCP request scope matrix`).toEqual([])
  expect(requests.length, `${kind} must make real MCP requests`).toBeGreaterThan(0)
}

test('captures every platform workbench /mcp request and checks scope', async ({ page }) => {
  const outputDir = process.env.OPS_E2E_OUTPUT_DIR
  expect(outputDir).toBeTruthy()
  const state = capture(page, 'platform')
  try {
    await openPlatformConsole(page, '/ops/overview?workbench=platform', { workbench: 'platform' })
    await walk(page, platformSections)
    await writeEvidence('platform', outputDir, state, 'platform')
  } finally { state.stop() }
})

test('captures every workspace workbench /mcp request and checks scope', async ({ page }) => {
  const outputDir = process.env.OPS_E2E_OUTPUT_DIR
  expect(outputDir).toBeTruthy()
  const state = capture(page, 'workspace')
  try {
    await openWorkspaceConsole(page, '/ops/overview?workbench=workspace')
    await walk(page, workspaceSections)
    await writeEvidence('workspace', outputDir, state, 'workspace')
  } finally { state.stop() }
})
