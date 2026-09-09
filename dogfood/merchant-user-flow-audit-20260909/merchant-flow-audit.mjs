import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'

const output = 'dogfood/merchant-user-flow-audit-20260909'
const sections = [
  ['overview', /^运营概览$/],
  ['knowledge-rules', /^知识库/],
  ['products', /^商品与资产$/],
  ['tasks', /^营销任务$/],
  ['publish', /^发布中心$/],
  ['rules', /^规则与检查$/],
  ['support', /^客服回复$/],
]

await mkdir(`${output}/screenshots`, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 })
const page = await context.newPage()
const events = []
const consoleErrors = []
page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ type: 'console', text: message.text() }) })
page.on('pageerror', error => consoleErrors.push({ type: 'pageerror', text: error.message }))
page.on('response', async response => {
  if (!response.url().includes('/api/')) return
  const request = response.request()
  let body = ''
  if (response.status() >= 400) {
    try { body = (await response.text()).slice(0, 2000) } catch {}
  }
  events.push({ at: new Date().toISOString(), status: response.status(), method: request.method(), url: response.url(), body })
})

const result = { startedAt: new Date().toISOString(), sections: [], consoleErrors }
const initial = await page.goto('http://127.0.0.1:18081/', { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForTimeout(3500)
await page.screenshot({ path: `${output}/screenshots/overview-before.png`, fullPage: true })
result.initialStatus = initial?.status()

for (const [name, pattern] of sections) {
  const before = events.length
  const button = page.locator('button').filter({ hasText: pattern }).first()
  const exists = await button.count()
  if (exists) {
    await button.click()
    await page.waitForTimeout(2500)
  }
  await page.screenshot({ path: `${output}/screenshots/${name}.png`, fullPage: true })
  const visibleText = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 3000)
  result.sections.push({ name, buttonFound: Boolean(exists), url: page.url(), apiEvents: events.slice(before), visibleText })
}

result.finishedAt = new Date().toISOString()
result.apiErrorCount = events.filter(event => event.status >= 400).length
result.rateLimited = events.filter(event => event.status === 429).map(event => ({ method: event.method, url: event.url, body: event.body }))
result.consoleErrors = consoleErrors
await writeFile(`${output}/observations.json`, JSON.stringify(result, null, 2))
console.log(JSON.stringify({
  initialStatus: result.initialStatus,
  sections: result.sections.map(section => ({ name: section.name, buttonFound: section.buttonFound, url: section.url, apiErrors: section.apiEvents.filter(event => event.status >= 400).length })),
  apiErrorCount: result.apiErrorCount,
  rateLimited: result.rateLimited.length,
  consoleErrors: result.consoleErrors,
}, null, 2))
await browser.close()
