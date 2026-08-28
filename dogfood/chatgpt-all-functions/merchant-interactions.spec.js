import { test, chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

test.setTimeout(120_000)

const state = async (page, name) => ({
  name,
  headings: await page.locator('h1,h2,h3,h4').allTextContents(),
  dialogs: await page.locator('[role="dialog"]').allTextContents(),
  statuses: await page.locator('[role="status"],[role="alert"]').allTextContents(),
  visibleText: (await page.locator('body').innerText()).slice(0, 12_000),
})

test('exercise Merchant Studio safe interactions and validation surfaces', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  context.setDefaultTimeout(8_000)
  const page = await context.newPage()
  const badResponses = []
  const requestFailures = []
  const consoleErrors = []
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('pageerror', error => consoleErrors.push(error.message))
  page.on('requestfailed', request => requestFailures.push({ url: request.url(), error: request.failure()?.errorText }))
  page.on('response', async response => {
    if (response.status() < 400) return
    let body = ''
    try { body = (await response.text()).slice(0, 3_000) } catch {}
    badResponses.push({ method: response.request().method(), url: response.url(), status: response.status(), body })
  })
  await page.goto('http://127.0.0.1:18081/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2_000)
  const steps = []
  const shots = resolve('screenshots', 'merchant-interactions')
  await mkdir(shots, { recursive: true })

  const health = page.getByRole('button', { name: /系统健康/ }).first()
  await health.click(); await page.waitForTimeout(500)
  steps.push(await state(page, '系统健康面板'))
  await page.screenshot({ path: resolve(shots, '1-health.png') })
  const healthDialog = page.getByRole('dialog')
  if (await healthDialog.count()) await healthDialog.getByRole('button', { name: /关闭|知道了/ }).first().click()

  const recharge = page.getByRole('button', { name: '充值并解锁', exact: true })
  await recharge.click(); await page.waitForTimeout(500)
  steps.push(await state(page, '充值门禁'))
  await page.screenshot({ path: resolve(shots, '2-wallet-gate.png') })
  const rechargeDialog = page.getByRole('dialog')
  if (await rechargeDialog.count()) await rechargeDialog.getByRole('button', { name: /关闭|取消/ }).first().click()

  await page.getByRole('button', { name: '商品与资产', exact: true }).first().click(); await page.waitForTimeout(1_200)
  const productSearch = page.getByPlaceholder('搜索商品或平台')
  await productSearch.fill('轻云'); await page.waitForTimeout(400)
  steps.push(await state(page, '商品搜索'))
  await page.getByRole('button', { name: /待确认/ }).first().click(); await page.waitForTimeout(300)
  steps.push(await state(page, '待确认筛选'))
  await page.screenshot({ path: resolve(shots, '3-product-filter.png') })

  const preference = page.getByRole('button', { name: '评价素材', exact: true }).first()
  if (await preference.count()) {
    await preference.click(); await page.waitForTimeout(300)
    steps.push(await state(page, '素材评价编辑器'))
    const cancel = page.getByRole('button', { name: '取消', exact: true }).first()
    if (await cancel.count()) await cancel.click()
  }
  const visualRules = page.getByRole('button', { name: '配置视觉强规则', exact: true })
  if (await visualRules.count() && await visualRules.isEnabled()) {
    await visualRules.click(); await page.waitForTimeout(300)
    steps.push(await state(page, '视觉强规则面板'))
    await page.screenshot({ path: resolve(shots, '4-visual-rules.png') })
  }

  await page.getByRole('button', { name: '规则与检查', exact: true }).first().click(); await page.waitForTimeout(900)
  await page.getByRole('tab', { name: /品类库/ }).click(); await page.waitForTimeout(300)
  const rulesSearch = page.getByPlaceholder(/搜索规则|搜索品类/)
  await rulesSearch.fill('服装'); await page.waitForTimeout(300)
  const platformSelect = page.locator('select').last()
  await platformSelect.selectOption('taobao'); await page.waitForTimeout(300)
  steps.push(await state(page, '品类与规则筛选'))
  await page.screenshot({ path: resolve(shots, '5-rules-filter.png') })

  await page.getByRole('button', { name: '帮助与诊断', exact: true }).click(); await page.waitForTimeout(300)
  steps.push(await state(page, '帮助面板'))
  const helpDialog = page.getByRole('dialog')
  if (await helpDialog.count()) await helpDialog.getByRole('button', { name: /知道了|关闭/ }).first().click()
  await page.getByRole('button', { name: '工作区设置', exact: true }).click(); await page.waitForTimeout(300)
  steps.push(await state(page, '工作区设置面板'))

  await writeFile('merchant-interactions.json', JSON.stringify({ steps, badResponses, requestFailures, consoleErrors }, null, 2))
  await context.close()
  await browser.close()
})
