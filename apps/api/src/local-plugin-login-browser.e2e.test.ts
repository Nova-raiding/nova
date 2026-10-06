import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { createServer as createViteServer } from 'vite'
import { afterEach, expect, it, vi } from 'vitest'
import { MemoryPasswordAuthRepository } from '../../../packages/persistence/src/password-auth-repository.js'
import { server as api, workspaceMembers, setPasswordAuthRepositoryForTests } from './server.js'

const close = (server: ReturnType<typeof createServer>) => new Promise<void>(resolve => server.close(() => resolve()))

it('returns from merchant login to the original local plugin consent in a browser', async () => {
  vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
  vi.stubEnv('MCP_INTEGRATION_MODE', 'local_stdio')
  vi.stubEnv('LOCAL_PLUGIN_ONE_CLICK_ENABLED', 'true')
  const repository = new MemoryPasswordAuthRepository()
  setPasswordAuthRepositoryForTests(repository)
  const workspaceId = `ws_login_browser_${Date.now()}`
  const login = `plugin-browser-${Date.now()}@example.test`
  const password = 'PluginBrowser1234!'
  const account = await repository.createMerchantAccount({ login, password, enterpriseName: 'Plugin Login Browser', contactName: 'Owner', workspaceIds: [workspaceId], actorId: 'platform-operator', reason: 'browser consent test' })
  await workspaceMembers.upsert({ workspaceId, externalSubject: login, displayName: login,
    role: 'workspace_owner', status: 'active', invitedBy: 'browser-consent-test' })
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
  const apiAddress = api.address()
  if (!apiAddress || typeof apiAddress === 'string') throw new Error('API did not bind')
  const apiBase = `http://127.0.0.1:${apiAddress.port}`
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let proxy: ReturnType<typeof createServer> | undefined
  try {
    proxy = createServer((req, res) => {
      if (req.url?.startsWith('/v1/') || req.url?.startsWith('/api/v1/')) {
        const upstreamPath = req.url.startsWith('/api/') ? req.url.slice('/api'.length) : req.url
        const upstream = request(new URL(upstreamPath, apiBase), { method: req.method, headers: req.headers }, response => {
          res.writeHead(response.statusCode ?? 502, response.headers)
          response.pipe(res)
        })
        upstream.on('error', () => res.writeHead(502).end())
        req.pipe(upstream)
      } else vite?.middlewares(req, res)
    })
    await new Promise<void>(resolve => proxy!.listen(0, '127.0.0.1', resolve))
    const address = proxy.address()
    if (!address || typeof address === 'string') throw new Error('Proxy did not bind')
    const base = `http://127.0.0.1:${address.port}`
    vi.stubEnv('PUBLIC_APP_BASE_URL', base)
    vi.stubEnv('VITE_API_BASE_URL', '/api')
    vite = await createViteServer({ root: resolve('demo/merchant-studio'), server: { middlewareMode: true } })
    const executablePath = [process.env.CHROME_BIN, chromium.executablePath(), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path))
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
    const page = await browser.newPage()
    page.setDefaultTimeout(5_000)
    const state = 's'.repeat(43)
    const authorization = new URL(`${base}/v1/auth/local-plugin/authorize`)
    for (const [name, value] of Object.entries({ response_type: 'code', client_id: 'local-desktop', redirect_uri: 'http://127.0.0.1:49191/merchant-mcp-callback', state, code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'), code_challenge_method: 'S256', scope: 'merchant', resource: `${base}/mcp`, workspace_id: workspaceId })) authorization.searchParams.set(name, value)
    await page.goto(authorization.toString())
    await page.getByRole('link', { name: '登录商家账号' }).click()
    try {
      await page.getByRole('heading', { name: '欢迎使用Store Nova' }).waitFor({ state: 'visible' })
    } catch {
      throw new Error(`Merchant login page did not load: ${page.url()} ${String(await page.locator('body').innerText()).slice(0, 800)}`)
    }
    await page.locator('#merchant-login-account').fill(login)
    await page.locator('#merchant-login-password').fill(password)
    await page.getByRole('button', { name: '登录商家工作台' }).click()
    try { await page.getByRole('button', { name: '确认授权本地插件' }).waitFor({ state: 'visible' }) }
    catch { throw new Error(`Plugin consent did not load: ${page.url()} ${String(await page.locator('body').innerText()).slice(0, 500)}`) }
    expect(new URL(page.url()).searchParams.get('state')).toBe(state)
    expect(await page.getByText(login).count()).toBeGreaterThan(0)
    expect(await page.getByText(workspaceId).count()).toBeGreaterThan(0)
    await page.getByRole('link', { name: '取消并返回商家后台' }).click()
    await page.getByRole('button', { name: '打开账号菜单' }).click()
    const connect = page.getByRole('button', { name: '连接 ChatGPT 本地插件' })
    await connect.waitFor({ state: 'visible' })
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button =>
      button.textContent?.includes('连接 ChatGPT 本地插件') && !button.disabled))
    expect(await connect.isEnabled()).toBe(true)
    await page.getByRole('button', { name: '安装与故障帮助' }).click()
    const dialog = page.getByRole('dialog', { name: '连接本地插件' })
    await dialog.waitFor({ state: 'visible' })
    expect(await dialog.innerText()).toContain('点击连接并按浏览器提示打开本地插件')
    expect(await dialog.innerText()).not.toMatch(/login-local|login\.cmd|runtime\/node/u)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await page.evaluate(({ origin, accountId, workspace }) => {
      window.localStorage.setItem(`storenova.plugin.installation:${origin}:${accountId}:${workspace}`,
        '11111111-1111-4111-8111-111111111111')
    }, { origin: base, accountId: account.id, workspace: workspaceId })
    await page.getByRole('button', { name: '打开账号菜单' }).click()
    await connect.click()
    await dialog.waitFor({ state: 'visible' })
    await dialog.getByText('连接失败，请重试').waitFor({ state: 'visible' })
    expect(await dialog.innerText()).toContain('本次连接未完成')
  } finally {
    await browser?.close()
    await vite?.close()
    if (proxy?.listening) await close(proxy)
    if (api.listening) await close(api)
    setPasswordAuthRepositoryForTests()
    vi.unstubAllEnvs()
  }
}, 60_000)
