import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'

const html = readFileSync(resolve(process.cwd(), 'apps/plugin/ui/image-local-edit.html'), 'utf8')
let browser: Browser

beforeAll(async () => { browser = await chromium.launch({ headless: true }) })
afterAll(async () => { await browser?.close() })

describe('image-local-edit canvas geometry and guardrails', () => {
  it('maps pointer coordinates through object-fit contain and fails closed without editable regions', async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
    await page.exposeFunction('mockCallTool', async () => ({ structuredContent: { id: 'unused' } }))
    await page.setContent(html.replace('<body>', '<body><script>window.openai = { callTool: (name, args) => window.mockCallTool(name, args) }</script>'))
    try {
      await page.setDefaultTimeout(5000)
      await page.locator('#imageWidth').fill('200')
      await page.locator('#imageHeight').fill('100')
      const bounds = await page.locator('#stage').evaluate((node) => {
        const rect = node.getBoundingClientRect()
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      })
      await page.mouse.move(bounds.left + bounds.width * 0.2, bounds.top + bounds.height * 0.4)
      await page.mouse.down()
      await page.mouse.move(bounds.left + bounds.width * 0.4, bounds.top + bounds.height * 0.45)
      await page.mouse.up()
      expect(await page.locator('#rectY').inputValue()).toBe('0.300')
      await page.locator('details').evaluate((element: HTMLDetailsElement) => { element.open = true })
      await page.locator('#editableJson').fill('[]')
      await page.locator('#editableJson').dispatchEvent('change')
      expect(await page.locator('#submit').isDisabled()).toBe(true)
      expect(await page.locator('#regionStatus').textContent()).toContain('至少提供一个有效的可修改区域')
    } finally {
      await page.close()
    }
  }, 15000)
})
