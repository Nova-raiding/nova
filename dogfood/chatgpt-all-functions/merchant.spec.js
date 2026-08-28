import { test, chromium } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const output = resolve('.')

test.setTimeout(120_000)

test('inventory merchant studio as a user', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  const page = await context.newPage()
  const messages = []
  const failedRequests = []
  const badResponses = []
  page.on('console', message => messages.push({ type: message.type(), text: message.text() }))
  page.on('pageerror', error => messages.push({ type: 'pageerror', text: error.message }))
  page.on('requestfailed', request => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }))
  page.on('response', async response => {
    if (response.status() >= 400) {
      let body = ''
      try { body = (await response.text()).slice(0, 8_000) } catch {}
      badResponses.push({
        url: response.url(),
        method: response.request().method(),
        requestBody: response.request().postData(),
        status: response.status(),
        statusText: response.statusText(),
        body,
      })
    }
  })

  const response = await page.goto('http://127.0.0.1:18081/', { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForTimeout(2_000)
  await page.screenshot({ path: `${output}/screenshots/merchant-desktop.png`, fullPage: true })
  const inventory = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    bodyText: document.body.innerText,
    buttons: Array.from(document.querySelectorAll('button')).map((element, index) => ({ index, text: (element.innerText || element.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' '), disabled: element.disabled })),
    links: Array.from(document.querySelectorAll('a')).map((element, index) => ({ index, text: (element.innerText || element.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' '), href: element.getAttribute('href') })),
    inputs: Array.from(document.querySelectorAll('input,textarea,select')).map((element, index) => ({ index, tag: element.tagName, type: element.getAttribute('type'), placeholder: element.getAttribute('placeholder'), label: element.getAttribute('aria-label'), value: element.value })),
    headings: Array.from(document.querySelectorAll('h1,h2,h3,h4')).map(element => ({ level: element.tagName, text: element.textContent?.trim() })),
  }))
  await writeFile(`${output}/merchant-inventory.json`, JSON.stringify({ status: response?.status(), messages, failedRequests, badResponses, inventory }, null, 2))

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })
  const mobilePage = await mobile.newPage()
  await mobilePage.goto('http://127.0.0.1:18081/', { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await mobilePage.waitForTimeout(1_500)
  await mobilePage.screenshot({ path: `${output}/screenshots/merchant-mobile.png`, fullPage: true })
  await mobile.close()
  await context.close()
  await browser.close()
})
