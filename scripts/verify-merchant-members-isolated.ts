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
    const failedRequests: string[] = []
    page.on('response', response => { if (response.url().includes('/api/') && response.status() >= 400) void response.json().then((body: { error?: { code?: string } }) => failedRequests.push(`${response.request().method()} ${new URL(response.url()).pathname} ${response.status()} ${body.error?.code ?? ''}`)).catch(() => undefined) })
    await page.goto(`${origin}/merchant/members`, { waitUntil: 'domcontentloaded' })
    await page.getByPlaceholder('例如 merchant@example.com').fill(login)
    await page.getByPlaceholder('请输入商家密码').fill(password)
    await page.getByRole('button', { name: '登录商家工作台' }).click()
    await page.waitForTimeout(1200)
    console.log(JSON.stringify({ memberBrowserUrl: page.url(), headings: await page.getByRole('heading').allTextContents(), alerts: await page.getByRole('alert').allTextContents(), failedRequests, pageErrors }))
    await expect(page.getByLabel('工作区成员管理').getByRole('heading', { name: '成员与权限' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('table', { name: '工作区成员列表' })).toContainText('隔离成员管理员', { timeout: 30_000 })
    await expect(page.getByRole('form', { name: '邀请工作区成员' })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await page.screenshot({ path: resolve(output, 'merchant-members-read.png'), fullPage: true })

    const invited = `invited-${randomUUID()}@fixture.invalid`
    const form = page.getByRole('form', { name: '邀请工作区成员' })
    await form.getByLabel('用户 ID').fill(invited)
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
    await writeFile(resolve(output, 'result.json'), JSON.stringify({ status: 'passed', auth: 'real-isolated-merchant-password-and-scoped-mcp-bearer', workspaceId: fixture.workspaceId, readVisible: true, invitePersisted: true, roleChangePersisted: true, suspendPersisted: true, browserErrors: pageErrors, productionBrowser: false }, null, 2), { mode: 0o600 })
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
