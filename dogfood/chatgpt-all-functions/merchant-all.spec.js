import { test, chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

test.setTimeout(180_000)
const root = resolve('.')
const screenshots = resolve(root, 'screenshots', 'merchant-pages')
const sections = ['运营概览', '商品与资产', '营销任务', '发布中心', '规则与检查', '帮助与诊断', '工作区设置']
const slug = new Map(sections.map((name, index) => [name, `${index + 1}-${['overview', 'catalog', 'tasks', 'publish', 'rules', 'help', 'settings'][index]}`]))

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
  page.on('requestfailed', request => requestFailures.push({ section: activeSection, method: request.method(), url: request.url(), error: request.failure()?.errorText }))
  page.on('response', async response => {
    if (response.status() < 400) return
    let body = ''
    try { body = (await response.text()).slice(0, 5_000) } catch {}
    badResponses.push({ section: activeSection, method: response.request().method(), url: response.url(), status: response.status(), requestBody: response.request().postData(), body })
  })

  await page.goto('http://127.0.0.1:18081/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2_500)
  const pages = []
  for (const section of sections) {
    activeSection = section
    await page.getByRole('button', { name: section, exact: true }).first().click()
    await page.waitForTimeout(1_500)
    await page.screenshot({ path: resolve(screenshots, `${slug.get(section)}.png`) })
    pages.push({ section, ...(await snapshot(page)) })
    const dialog = page.getByRole('dialog')
    if (await dialog.count()) {
      const close = dialog.getByRole('button', { name: /关闭面板|知道了/ }).first()
      if (await close.count()) await close.click()
    }
  }

  activeSection = '全局搜索'
  await page.getByRole('button', { name: '运营概览', exact: true }).first().click()
  const search = page.getByLabel('搜索商品')
  if (await search.count()) {
    await search.fill('轻云')
    await page.waitForTimeout(800)
    pages.push({ section: '全局搜索', ...(await snapshot(page)) })
    await page.screenshot({ path: resolve(screenshots, '8-global-search.png') })
    await search.fill('')
  }

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })
  const mobilePage = await mobile.newPage()
  activeSection = '移动端'
  await mobilePage.goto('http://127.0.0.1:18081/', { waitUntil: 'domcontentloaded' })
  await mobilePage.waitForTimeout(2_000)
  const menu = mobilePage.getByRole('button', { name: '打开主菜单' })
  if (await menu.count()) await menu.click()
  await mobilePage.screenshot({ path: resolve(screenshots, '9-mobile-menu.png') })
  const mobileState = await snapshot(mobilePage)

  const result = { generatedAt: new Date().toISOString(), pages, mobile: mobileState, consoleMessages, requestFailures, badResponses }
  await writeFile(resolve(root, 'merchant-all-inventory.json'), JSON.stringify(result, null, 2))
  await mobile.close()
  await context.close()
  await browser.close()
})
