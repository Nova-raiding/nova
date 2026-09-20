import { expect, test, chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ensureMerchantSession } from './merchant-auth.js'

test.setTimeout(180_000)
const root = resolve('.')
const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:18081/'
const screenshots = resolve(root, 'screenshots', 'merchant-pages')
// The reviewed sidebar (fdd6deac) exposes these six sections directly. The
// former 知识库 group label is no longer a button, and the 查看系统健康与上线状态
// utility entry no longer exists — see retired-merchant-assertions.md.
const sections = ['运营概览', '平台&店铺&商品', '品牌资产', '素材库', '回收站', '财务概况']
const sectionSlugs = ['overview', 'catalog', 'brand-assets', 'materials', 'trash', 'finance']
const slug = new Map(sections.map((name, index) => [name, `${index + 1}-${sectionSlugs[index]}`]))

const snapshot = async page => page.evaluate(() => ({
  url: location.href,
  title: document.title,
  text: document.body.innerText.slice(0, 30_000),
  headings: [...document.querySelectorAll('h1,h2,h3,h4')].map(element => element.textContent?.trim()).filter(Boolean),
  buttons: [...document.querySelectorAll('button')].map(element => ({ text: (element.innerText || element.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' '), disabled: element.disabled })).filter(item => item.text),
  inputs: [...document.querySelectorAll('input,textarea,select')].map(element => ({ tag: element.tagName, type: element.getAttribute('type'), placeholder: element.getAttribute('placeholder'), label: element.getAttribute('aria-label'), value: element.value })),
  dialogs: [...document.querySelectorAll('[role="dialog"]')].map(element => element.textContent?.trim()).filter(Boolean),
}))

test('walk every Merchant Studio section through the real browser UI', async () => {
  await mkdir(screenshots, { recursive: true })
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  context.setDefaultTimeout(10_000)
  const page = await context.newPage()
  const consoleMessages = []
  const requestFailures = []
  const badResponses = []
  let activeSection = '启动'
  page.on('console', message => consoleMessages.push({ section: activeSection, type: message.type(), text: message.text() }))
  page.on('pageerror', error => consoleMessages.push({ section: activeSection, type: 'pageerror', text: error.message }))
  page.on('requestfailed', request => {
    const error = request.failure()?.errorText
    if (error === 'net::ERR_ABORTED') return
    requestFailures.push({ section: activeSection, method: request.method(), url: request.url(), error })
  })
  page.on('response', async response => {
    if (response.status() < 400) return
    let body = ''
    try { body = (await response.text()).slice(0, 5_000) } catch {}
    badResponses.push({ section: activeSection, method: response.request().method(), url: response.url(), status: response.status(), requestBody: response.request().postData(), body })
  })

  const response = await page.goto(studioUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2_500)
  await ensureMerchantSession(page)
  await expect(page.getByRole('button', { name: '工作区信息', exact: true })).toHaveCount(0)
  const pages = []
  for (const section of sections) {
    activeSection = section
    await page.getByRole('button', { name: section, exact: true }).first().click()
    await page.waitForTimeout(1_500)
    if (section === '运营概览') {
      // The reviewed overview (c2eafb72, "visual review") hides the dashboard
      // grid, the sync actions row and the data-integrity panel with CSS. The
      // old layout block measured `article.platform-panel` inside that hidden
      // grid, so it could only ever report zeroed rects. Assert the visible
      // overview landmarks instead, and pin the review decision so a future
      // change that re-shows those surfaces is noticed rather than silently
      // restoring stale layout expectations.
      await expect(page.getByRole('heading', { name: '运营概览' })).toBeVisible()
      for (const landmark of ['今日看板', '账号看板', '事务看板']) {
        await expect(page.getByRole('heading', { name: landmark })).toBeVisible()
      }
      for (const hidden of ['.overview-sync-actions', '.data-integrity-panel', '.dashboard-grid']) {
        await expect(page.locator(hidden), `${hidden} is hidden by the visual-review decision`).toBeHidden()
      }
      await page.evaluate(async () => {
        await document.fonts.ready
        await new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)))
      })
      const layout = await page.evaluate(() => ({
        viewportWidth: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }))
      expect(layout).toMatchObject({ viewportWidth: 1440 })
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewportWidth + 1)
    }
    await page.screenshot({ path: resolve(screenshots, `${slug.get(section)}.png`) })
    pages.push({ section, ...(await snapshot(page)) })
    const dialog = page.getByRole('dialog')
    if (await dialog.count()) {
      const close = dialog.getByRole('button', { name: /关闭面板|知道了/ }).first()
      if (await close.count()) await close.click()
    }
  }

  // The 查看系统健康与上线状态 utility walk was retired with the rest of the
  // environment-readiness surface (2e055921). See retired-merchant-assertions.md.

  activeSection = '全局搜索'
  // The global search box now lives on the product catalog rather than the
  // overview; the overview has no search input since the visual review.
  await page.goto(new URL('merchant/tasks/new', studioUrl).toString())
  await page.waitForTimeout(1_500)
  const search = page.getByLabel('搜索商品')
  await expect(search, 'the product catalog search box must exist for this walk to mean anything').toHaveCount(1)
  await search.fill('轻云')
  await page.waitForTimeout(800)
  pages.push({ section: '全局搜索', ...(await snapshot(page)) })
  await page.screenshot({ path: resolve(screenshots, '8-global-search.png') })
  await search.fill('')

  const result = { generatedAt: new Date().toISOString(), pages, consoleMessages, requestFailures, badResponses }
  await writeFile(resolve(root, 'merchant-all-inventory.json'), JSON.stringify(result, null, 2))
  try {
    const consoleErrors = consoleMessages.filter(message => (message.type === 'error' || message.type === 'pageerror') && !message.text.includes('status of 401'))
    const filteredBadResponses = badResponses.filter(item => !(item.url.endsWith('/v1/auth/session') && item.status === 401 && item.body.includes('AUTH_SESSION_INVALID')))
    expect(response?.ok(), 'Merchant Studio entry page should return a successful response').toBe(true)
    expect(filteredBadResponses, 'Merchant Studio page walk should not observe HTTP error responses').toEqual([])
    expect(requestFailures, 'Merchant Studio page walk should not observe failed network requests').toEqual([])
    expect(consoleErrors, 'Merchant Studio page walk should not observe console or page errors').toEqual([])
  } finally {
    await context.close()
    await browser.close()
  }
})
