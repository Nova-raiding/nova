import { test, chromium } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

test.setTimeout(120_000)

test('inventory Ops Console through the real browser UI', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => {
    localStorage.setItem('ops_workspace_id', 'ws_demo')
    localStorage.setItem('ops_actor_id', 'actor_demo')
    localStorage.setItem('ops_api_token', 'pilot-local-token')
  })
  const page = await context.newPage()
  const consoleMessages = []
  const requestFailures = []
  const badResponses = []
  page.on('console', message => consoleMessages.push({ type: message.type(), text: message.text() }))
  page.on('pageerror', error => consoleMessages.push({ type: 'pageerror', text: error.message }))
  page.on('requestfailed', request => requestFailures.push({ method: request.method(), url: request.url(), error: request.failure()?.errorText }))
  page.on('response', async response => {
    if (response.status() < 400) return
    let body = ''
    try { body = (await response.text()).slice(0, 5_000) } catch {}
    badResponses.push({ method: response.request().method(), url: response.url(), status: response.status(), requestBody: response.request().postData(), body })
  })
  const response = await page.goto('http://127.0.0.1:18082/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(6_000)
  await page.screenshot({ path: resolve('screenshots', 'ops-console.png'), fullPage: true })
  const inventory = await page.evaluate(() => ({
    title: document.title,
    text: document.body.innerText.slice(0, 40_000),
    headings: [...document.querySelectorAll('h1,h2,h3,h4')].map(element => element.textContent?.trim()).filter(Boolean),
    buttons: [...document.querySelectorAll('button')].map(element => ({ text: (element.innerText || element.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' '), disabled: element.disabled })).filter(item => item.text),
    inputs: [...document.querySelectorAll('input,textarea,select')].map(element => ({ tag: element.tagName, type: element.getAttribute('type'), placeholder: element.getAttribute('placeholder'), label: element.getAttribute('aria-label'), value: element.value })),
    tabs: [...document.querySelectorAll('[role="tab"]')].map(element => ({ text: element.textContent?.trim(), selected: element.getAttribute('aria-selected') })),
  }))
  await writeFile('ops-inventory.json', JSON.stringify({ status: response?.status(), inventory, consoleMessages, requestFailures, badResponses }, null, 2))
  await context.close()
  await browser.close()
})
