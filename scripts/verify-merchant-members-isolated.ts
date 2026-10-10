import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { resolve } from 'node:path'
import { chromium, expect } from '@playwright/test'
import { Pool } from 'pg'
import { PostgresMembersRepository } from '../packages/persistence/src/members-repository.js'
import { PostgresPasswordAuthRepository } from '../packages/persistence/src/password-auth-repository.js'
import { runOpsE2e, type OpsE2eContext } from './run-ops-password-e2e.js'

function merchantProxy(uiUpstream: string, apiUpstream: string) {
  return createHttpServer((incoming, outgoing) => {
    const apiRequest = incoming.url?.startsWith('/api/') || incoming.url === '/api'
    const upstreamUrl = new URL(incoming.url ?? '/', apiRequest ? apiUpstream : uiUpstream)
    if (apiRequest) upstreamUrl.pathname = upstreamUrl.pathname.replace(/^\/api(?=\/|$)/u, '') || '/'
    const headers = { ...incoming.headers, host: upstreamUrl.host, 'x-forwarded-host': incoming.headers.host, 'x-forwarded-proto': 'http' }
    const upstream = httpRequest(upstreamUrl, { method: incoming.method, headers }, response => { outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing) })
    upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end() })
    incoming.pipe(upstream)
  })
}

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolveReady, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveReady) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('MERCHANT_MEMBERS_PORT_UNAVAILABLE')
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  return address.port
}

async function ready(url: string, process: ChildProcess) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (process.exitCode !== null || process.signalCode !== null) throw new Error('MERCHANT_MEMBERS_UI_EXITED')
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1_000) })).ok) return } catch { /* startup */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error('MERCHANT_MEMBERS_UI_NOT_READY')
}

async function verify(context: OpsE2eContext) {
  const { fixture, evidenceDir } = context
  const output = resolve(evidenceDir, 'merchant-members')
  await mkdir(output, { recursive: true, mode: 0o700 })
  const login = `member-admin-${fixture.runId}@fixture.invalid`
  const password = `A1${randomBytes(24).toString('hex')}`
  // Fixture seeding is performed by the disposable container's admin role;
  // the browser API itself still runs under the restricted app/ops roles.
  const pool = new Pool({ connectionString: fixture.adminDatabaseUrl, max: 2 })
  const authPool = new Pool({ connectionString: fixture.opsDatabaseUrl, max: 1 })
  let preview: ChildProcess | undefined
  let gateway: ReturnType<typeof merchantProxy> | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    const account = await new PostgresPasswordAuthRepository(authPool).createMerchantAccount({
      login, password, enterpriseName: '隔离成员验收企业', contactName: '隔离成员管理员',
      workspaceIds: [fixture.workspaceId], actorId: 'isolated-browser-fixture', reason: 'isolated member management browser verification',
    })
    const members = new PostgresMembersRepository(pool)
    await members.upsert({ workspaceId: fixture.workspaceId, externalSubject: login, displayName: '隔离成员管理员', role: 'merchant_admin', status: 'active', invitedBy: 'isolated-browser-fixture' })
    if (account.identityId) await members.bindIdentity({ workspaceId: fixture.workspaceId, externalSubject: login, identityId: account.identityId })

    const merchantDist = resolve(output, 'merchant-dist')
    const childEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', LANG: 'C.UTF-8', NODE_ENV: 'production', VITE_API_BASE_URL: '/api' }
    execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', 'demo/merchant-studio', '--config', 'demo/merchant-studio/vite.config.ts', '--outDir', merchantDist], { env: childEnv, stdio: 'ignore', timeout: 90_000 })
    const previewPort = await freePort()
    preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(previewPort), '--strictPort', '--outDir', merchantDist], { env: childEnv, stdio: 'ignore' })
    await ready(`http://127.0.0.1:${previewPort}/`, preview)
    const runtime = JSON.parse(await readFile(resolve(evidenceDir, 'runtime.json'), 'utf8')) as { apiPort: number }
    const gatewayPort = await freePort()
    gateway = merchantProxy(`http://127.0.0.1:${previewPort}`, `http://127.0.0.1:${runtime.apiPort}`)
    await new Promise<void>((resolveListen, reject) => { gateway!.once('error', reject); gateway!.listen(gatewayPort, '127.0.0.1', resolveListen) })
    const origin = `http://127.0.0.1:${gatewayPort}`
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai' })
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    const observedApiRequests: string[] = []
    const observedApiResponses: string[] = []
    page.on('request', request => {
      const url = new URL(request.url())
      if (url.origin === origin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/'))) {
        observedApiRequests.push(`${request.method()} ${url.pathname}`)
      }
    })
    const failedRequests: string[] = []
    page.on('response', response => {
      const url = new URL(response.url())
      if (url.origin === origin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/'))) {
        observedApiResponses.push(`${response.request().method()} ${url.pathname} ${response.status()}`)
      }
      if (url.origin === origin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/')) && response.status() >= 400) void response.json().then((body: { error?: { code?: string } }) => failedRequests.push(`${response.request().method()} ${url.pathname} ${response.status()} ${body.error?.code ?? ''}`)).catch(() => undefined)
    })
    const loginResponses: Array<{ status: number; code: string | null }> = []
    page.on('response', response => {
      const url = new URL(response.url())
      if (url.origin !== origin || !url.pathname.endsWith('/v1/auth/login')) return
      void response.json().then((body: { error?: { code?: string } }) => loginResponses.push({ status: response.status(), code: body.error?.code ?? null })).catch(() => loginResponses.push({ status: response.status(), code: null }))
    })
    page.on('requestfailed', request => {
      const url = new URL(request.url())
      if (url.origin === origin && url.pathname.endsWith('/v1/auth/login')) failedRequests.push(`POST /v1/auth/login network ${request.failure()?.errorText ?? 'unknown'}`)
    })
    await page.goto(`${origin}/merchant/members`, { waitUntil: 'domcontentloaded' })
    const loginName = page.locator('#merchant-login-account')
    const loginPassword = page.locator('#merchant-login-password')
    const loginForm = page.getByRole('form', { name: '商家账号登录' })
    await expect(loginForm).toBeVisible()
    const loginButton = page.getByRole('button', { name: '登录商家工作台', exact: true })
    await loginName.fill(login)
    await loginPassword.fill(password)
    await expect.poll(async () => {
      if (await page.locator('.app-shell').isVisible().catch(() => false)) return 'authenticated'
      if (await loginButton.isVisible().catch(() => false)) return await loginButton.isEnabled() ? 'ready' : 'loading'
      return 'loading'
    }, { timeout: 30_000, message: 'merchant login button must become ready after filling the account fields' }).toMatch(/authenticated|ready/)
    const appShell = page.locator('.app-shell')
    if (!await appShell.isVisible().catch(() => false)) await loginButton.click()
    try {
      await expect.poll(() => loginResponses.length, { timeout: 15_000, message: 'merchant login form must submit an API request' }).toBeGreaterThan(0)
    } catch (error) {
      const debug = {
        url: page.url(),
        headings: await page.getByRole('heading').allTextContents(),
        alerts: await page.getByRole('alert').allTextContents(),
        loginFormCount: await loginForm.count(),
        loginNamePresent: Boolean(await loginName.inputValue().catch(() => '')),
        passwordLength: (await loginPassword.inputValue().catch(() => '')).length,
        submitDisabled: await loginButton.isDisabled().catch(() => true),
        observedApiRequests,
        observedApiResponses,
        failedRequests,
        pageErrors,
      }
      await page.screenshot({ path: resolve(output, 'merchant-login-submit-failure.png'), fullPage: true }).catch(() => undefined)
      await writeFile(resolve(output, 'merchant-login-submit-failure.json'), JSON.stringify(debug, null, 2), { mode: 0o600 })
      throw error
    }
    expect(loginResponses[0]?.status, `merchant login API response code: ${loginResponses[0]?.code ?? 'unknown'}`).toBe(200)
    await expect(page.getByLabel('工作区成员管理').getByRole('heading', { name: '成员与权限' })).toBeVisible({ timeout: 30_000 })
    console.log(JSON.stringify({ memberBrowserUrl: page.url(), headings: await page.getByRole('heading').allTextContents(), alerts: await page.getByRole('alert').allTextContents(), failedRequests, pageErrors, loginResponses }))
    await expect(page.getByRole('table', { name: '工作区成员列表' })).toContainText('隔离成员管理员', { timeout: 30_000 })
    await expect(page.getByRole('form', { name: '邀请工作区成员' })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    // Exercise the shared HttpOnly password session directly so browser-side
    // issuance serialization cannot conceal a server token-row deadlock.
    const concurrentIssuance = await page.evaluate(async (workspaceId) => Promise.all(Array.from({ length: 4 }, async () => {
      const response = await fetch('/api/v1/auth/mcp-token', {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId }),
      })
      const payload = await response.json() as { error?: { code?: string } }
      return { status: response.status, code: payload.error?.code ?? null }
    })), fixture.workspaceId)
    expect(concurrentIssuance).toEqual(Array.from({ length: 4 }, () => ({ status: 200, code: null })))
    await page.screenshot({ path: resolve(output, 'merchant-members-read.png'), fullPage: true })

    const invited = `invited-${randomUUID()}@fixture.invalid`
    const form = page.getByRole('form', { name: '邀请工作区成员' })
    const inviteAccount = form.getByLabel('成员登录账号')
    await expect(inviteAccount).toHaveAttribute('placeholder', '例如：member@example.com 或平台账号')
    await expect(inviteAccount).toHaveAttribute('aria-describedby', 'merchant-member-invite-account-help')
    await expect(page.locator('#merchant-member-invite-account-help')).toContainText('系统会按此账号关联成员记录')
    await inviteAccount.fill(invited)
    await form.getByLabel('显示名').fill('隔离邀请成员')
    await form.getByLabel('邀请原因').fill('隔离浏览器验收邀请')
    await form.getByRole('button', { name: '邀请成员' }).click()
    await expect(page.getByRole('table', { name: '工作区成员列表' })).toContainText('隔离邀请成员', { timeout: 30_000 })
    const persisted = (await members.list(fixture.workspaceId)).find(member => member.externalSubject === invited)
    expect(persisted?.status).toBe('invited')
    expect(persisted?.role).toBe('operator')
    const invitedRow = page.getByRole('row').filter({ hasText: '隔离邀请成员' })
    await invitedRow.getByRole('button', { name: '改角色' }).click()
    const roleForm = page.getByRole('form', { name: '成员变更' })
    await roleForm.getByLabel('新角色').selectOption('support')
    await roleForm.getByLabel('操作原因').fill('隔离浏览器验收角色调整')
    await roleForm.getByRole('button', { name: '确认改角色' }).click()
    await expect(invitedRow).toContainText('支持', { timeout: 30_000 })
    expect((await members.list(fixture.workspaceId)).find(member => member.externalSubject === invited)?.role).toBe('support')
    await invitedRow.getByRole('button', { name: '停用' }).click()
    const suspendForm = page.getByRole('form', { name: '成员变更' })
    await suspendForm.getByLabel('操作原因').fill('隔离浏览器验收停用')
    await suspendForm.getByRole('button', { name: '确认停用' }).click()
    await expect(invitedRow).toContainText('已停用', { timeout: 30_000 })
    expect((await members.list(fixture.workspaceId)).find(member => member.externalSubject === invited)?.status).toBe('suspended')
    expect(pageErrors).toEqual([])
    await page.screenshot({ path: resolve(output, 'merchant-members-invited.png'), fullPage: true })
    await writeFile(resolve(output, 'result.json'), JSON.stringify({ status: 'passed', auth: 'real-isolated-merchant-password-and-scoped-mcp-bearer', workspaceId: fixture.workspaceId, readVisible: true, concurrentIssuance, invitePersisted: true, roleChangePersisted: true, suspendPersisted: true, browserErrors: pageErrors, productionBrowser: false }, null, 2), { mode: 0o600 })
  } finally {
    await browser?.close().catch(() => undefined)
    if (gateway?.listening) await new Promise<void>(resolveClose => gateway!.close(() => resolveClose()))
    if (preview) { preview.kill('SIGTERM'); await new Promise<void>(resolveExit => preview!.once('exit', () => resolveExit())) }
    await pool.end()
    await authPool.end()
  }
}

runOpsE2e(['dogfood/chatgpt-all-functions/ops-members-global-isolated.spec.js'], process.env, verify)
  .then(code => { process.exitCode = code }, error => { console.error(error instanceof Error ? error.message : 'MERCHANT_MEMBERS_ISOLATED_FAILED'); process.exitCode = 1 })
