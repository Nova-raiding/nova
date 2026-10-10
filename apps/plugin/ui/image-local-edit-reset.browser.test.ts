import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'

const html = readFileSync(resolve(process.cwd(), 'apps/plugin/ui/image-local-edit.html'), 'utf8')
let browser: Browser

beforeAll(async () => { browser = await chromium.launch({ headless: true }) })
afterAll(async () => { await browser?.close() })

describe('image-local-edit reset behavior', () => {
  it('restores the default edit region and returns keyboard focus to it', async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
    page.setDefaultTimeout(5000)
    await page.exposeFunction('mockCallTool', async () => ({ structuredContent: {} }))
    await page.setContent(html.replace('<body>', '<body><script>window.openai = { callTool: (name, args) => window.mockCallTool(name, args) }</script>'))
    try {
      await page.locator('#imageWidth').fill('200')
      await page.locator('#imageHeight').fill('100')
      const bounds = await page.locator('#stage').evaluate((node) => {
        const rect = node.getBoundingClientRect()
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      })
      await page.mouse.move(bounds.left + bounds.width * 0.1, bounds.top + bounds.height * 0.1)
      await page.mouse.down()
      await page.mouse.move(bounds.left + bounds.width * 0.6, bounds.top + bounds.height * 0.6)
      await page.mouse.up()

      await page.locator('#reset').click()

      expect(await page.locator('#rectX').inputValue()).toBe('0.350')
      expect(await page.locator('#rectY').inputValue()).toBe('0.350')
      expect(await page.locator('#rectW').inputValue()).toBe('0.300')
      expect(await page.locator('#rectH').inputValue()).toBe('0.300')
      await expectFocusOnSelection(page)
    } finally {
      await page.close()
    }
  }, 15000)

  it('blocks submission when the selected edit region overlaps a protected asset area', async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
    page.setDefaultTimeout(5000)
    let toolCalls = 0
    await page.exposeFunction('mockCallTool', async () => { toolCalls += 1; return { structuredContent: { id: 'unexpected-candidate' } } })
    await page.setContent(html.replace('<body>', '<body><script>window.openai = { callTool: (name, args) => window.mockCallTool(name, args) }</script>'))
    try {
      await page.evaluate(() => {
        const values: Record<string, string> = {
          sourceId: 'asset-current-workspace',
          imageUrl: 'data:image/png;base64,iVBORw0KGgo=',
          prompt: '仅修正非商品区域文字',
          productId: 'product-current-workspace',
          protectedJson: JSON.stringify([{ id: 'brand-logo', label: '品牌 Logo', rect: { x: 0.4, y: 0.4, width: 0.1, height: 0.1 } }]),
        }
        for (const [id, value] of Object.entries(values)) {
          const field = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement
          field.value = value
          field.dispatchEvent(new Event(id === 'protectedJson' ? 'change' : 'input', { bubbles: true }))
        }
      })

      expect(await page.locator('#submit').isDisabled()).toBe(true)
      expect(await page.locator('#regionStatus').textContent()).toContain('不可修改区域“品牌 Logo”重叠')
      await page.locator('#editorForm').evaluate((form: HTMLFormElement) => form.requestSubmit())
      expect(await page.locator('#formError').textContent()).toContain('不可修改区域“品牌 Logo”重叠')
      expect(toolCalls).toBe(0)
    } finally {
      await page.close()
    }
  }, 15000)
})

async function expectFocusOnSelection(page: import('playwright').Page): Promise<void> {
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('selection')
}
