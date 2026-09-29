import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { runOpsE2e } from './run-ops-password-e2e.js'

async function capture(context: Parameters<NonNullable<Parameters<typeof runOpsE2e>[2]>>[0]) {
  const { fixture, evidenceDir, environment } = context
  const origin = environment.MERCHANT_STUDIO_URL
  if (!origin) throw new Error('MERCHANT_ISOLATED_UI_URL_MISSING')
  const output = resolve(evidenceDir, 'merchant-desktop-matrix')
  await mkdir(output, { recursive: true, mode: 0o700 })
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const opsLoginPage = await browser.newPage({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Shanghai' })
    const opsLoginErrors: string[] = []
    opsLoginPage.on('pageerror', error => opsLoginErrors.push(error.message))
    await opsLoginPage.goto(`${context.baseUrl}/ops/overview?workbench=platform`, { waitUntil: 'domcontentloaded' })
    await opsLoginPage.getByRole('button', { name: '登录平台运营后台', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    const opsLoginScreenshot = resolve(evidenceDir, 'desktop-readonly-matrix', '00-login.png')
    await opsLoginPage.screenshot({ path: opsLoginScreenshot, fullPage: true })
    await opsLoginPage.close()
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Shanghai' })
    const pageErrors: string[] = []
    const failedApi: Array<{ path: string; status: number; method: string }> = []
    const expectedAuthProbeFailures: Array<{ path: string; status: number; method: string }> = []
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('response', response => {
      if (response.url().includes('/api/') && response.status() >= 400) {
        const failure = { path: new URL(response.url()).pathname, status: response.status(), method: response.request().method() }
        if (failure.path === '/api/v1/auth/session' && failure.status === 401 && failure.method === 'GET') expectedAuthProbeFailures.push(failure)
        else failedApi.push(failure)
      }
    })
    const routes = [
      ['overview', '/merchant/overview', '今日看板'],
      ['catalog', '/merchant/products?section=products', '选择平台与店铺'],
      ['knowledge', '/merchant/products?section=knowledge', '素材库'],
      ['images', '/merchant/products?section=images', '素材库'],
      ['brands', '/merchant/products?section=assets', '品牌资产'],
      ['trash', '/merchant/products?section=trash', '回收站'],
      ['finance', '/merchant/finance', '财务与资源'],
      ['tasks', '/merchant/tasks', '素材库', '/merchant/products'],
      ['publish', '/merchant/publish', '素材库', '/merchant/products'],
      ['rules', '/merchant/rules', '素材库', '/merchant/products'],
    ] as const
    await page.goto(`${origin}/merchant/overview`, { waitUntil: 'domcontentloaded' })
    await page.locator('main').waitFor({ state: 'visible', timeout: 30_000 })
    // Capture the stable signed-out screen after the session probe finishes;
    // otherwise the button is dimmed by the transient auth-loading state.
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find(candidate => candidate.textContent?.includes('登录商家工作台'))
      return button && !button.disabled
    }, undefined, { timeout: 30_000 })
    const loginButtonVisual = await page.getByRole('button', { name: '登录商家工作台', exact: true }).evaluate(button => ({
      disabled: (button as HTMLButtonElement).disabled,
      ariaBusy: button.getAttribute('aria-busy'),
      className: button.className,
      backgroundColor: getComputedStyle(button).backgroundColor,
      opacity: getComputedStyle(button).opacity,
    }))
    await page.screenshot({ path: resolve(output, '00-login.png'), fullPage: true })
    await page.getByPlaceholder('例如 merchant@example.com').fill(fixture.merchantLogin)
    await page.getByPlaceholder('请输入商家密码').fill(fixture.merchantPassword)
    const loginResponse = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/v1/auth/login' && response.request().method() === 'POST'
    }, { timeout: 30_000 })
    await page.getByRole('button', { name: '登录商家工作台', exact: true }).click()
    const login = await loginResponse
    if (!login.ok()) throw new Error(`MERCHANT_ISOLATED_LOGIN_HTTP_${login.status()}`)
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 })
    const sessionResponse = await page.evaluate(async () => {
      const response = await fetch('/api/v1/auth/session', { credentials: 'include', cache: 'no-store' })
      return { status: response.status, hasCookie: document.cookie.includes('damai_session=') }
    })
    if (sessionResponse.status !== 200) {
      throw new Error(`MERCHANT_ISOLATED_SESSION_HTTP_${sessionResponse.status}_COOKIE_VISIBLE_${sessionResponse.hasCookie}`)
    }
    const routeEvidence: Array<{ name: string; requestedPath: string; finalPath: string; heading: string; geometry: { viewportWidth: number; sidebarWidth: number; mainShellOffset: number } }> = []
    for (const [name, route, expectedHeading, expectedPath] of routes) {
      await page.goto(new URL(route, origin).toString(), { waitUntil: 'networkidle', timeout: 30_000 })
      await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 })
      await page.locator('main').waitFor({ state: 'visible', timeout: 30_000 })
      const routeContent = await page.locator('main').innerText()
      if (routeContent.includes('欢迎使用Store Nova') || routeContent.includes('登录商家工作台')) {
        throw new Error(`MERCHANT_ISOLATED_ROUTE_RETURNED_LOGIN_${name}`)
      }
      if (!routeContent.includes(expectedHeading)) throw new Error(`MERCHANT_ISOLATED_ROUTE_HEADING_MISSING_${name}`)
      if (/正在读取/u.test(routeContent)) throw new Error(`MERCHANT_ISOLATED_ROUTE_STILL_LOADING_${name}`)
      const currentUrl = new URL(page.url())
      const finalPath = `${currentUrl.pathname}${currentUrl.search}`
      if (expectedPath && finalPath !== expectedPath) throw new Error(`MERCHANT_ISOLATED_ROUTE_CANONICAL_PATH_MISMATCH_${name}`)
      const geometry = await page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        sidebarWidth: document.querySelector<HTMLElement>('.sidebar')?.getBoundingClientRect().width ?? 0,
        mainShellOffset: document.querySelector<HTMLElement>('.main-shell')?.getBoundingClientRect().left ?? 0,
      }))
      if (geometry.sidebarWidth !== 224 || geometry.mainShellOffset !== 224) {
        throw new Error(`MERCHANT_DESKTOP_GEOMETRY_MISMATCH_${name}_${geometry.sidebarWidth}_${geometry.mainShellOffset}`)
      }
      routeEvidence.push({ name, requestedPath: route, finalPath, heading: expectedHeading, geometry })
      await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true })
    }
    const result = { status: pageErrors.length || failedApi.length ? 'failed' : 'passed', isolated: true,
      persistence: 'disposable PostgreSQL + Redis', workspaceId: fixture.workspaceId,
      opsLoginScreenshot, opsLoginPageErrors: opsLoginErrors,
      routes: routeEvidence, pageErrors, failedApi,
      loginButtonVisual, expectedLoginProbeCount: expectedAuthProbeFailures.length, productionBrowser: false }
    await writeFile(resolve(output, 'matrix.json'), JSON.stringify(result, null, 2), { mode: 0o600 })
    if (result.status !== 'passed') throw new Error('MERCHANT_ISOLATED_BROWSER_MATRIX_FAILED')
  } finally { await browser.close() }
}

runOpsE2e(['dogfood/chatgpt-all-functions/ops-merchant-matrix-bootstrap.spec.js'],
  { ...process.env, OPS_E2E_MERCHANT_UI: 'true' }, capture)
  .then(code => { process.exitCode = code }, error => { console.error(error instanceof Error ? error.message : 'MERCHANT_ISOLATED_MATRIX_FAILED'); process.exitCode = 1 })
