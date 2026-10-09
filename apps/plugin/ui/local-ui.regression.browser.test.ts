import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'

const imageEditHtml = readFileSync(resolve(process.cwd(), 'apps/plugin/ui/image-local-edit.html'), 'utf8')
const rechargeHtml = readFileSync(resolve(process.cwd(), 'apps/plugin/ui/recharge.html'), 'utf8')
let browser: Browser

beforeAll(async () => { browser = await chromium.launch({ headless: true }) })
afterAll(async () => { await browser?.close() })

async function pageWithHost(html: string, callTool: (name: string, args: Record<string, unknown>) => unknown): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  await page.exposeFunction('mockCallTool', callTool)
  await page.setContent(html.replace('<body>', '<body><script>window.openai = { callTool: (name, args) => window.mockCallTool(name, args) }</script>'))
  return page
}

describe('packaged MCP App UI regressions', () => {
  it('renders the server-created image edit candidate from structured tool output', async () => {
    let submittedName = ''
    const page = await pageWithHost(imageEditHtml, async (name) => {
      submittedName = name
      return { structuredContent: { id: 'candidate-from-server', modelVersion: 'relay-image-edit-v3', images: ['data:image/png;base64,aGVsbG8='], originalPreserved: true } }
    })
    try {
      await page.setDefaultTimeout(12000)
      await page.locator('#sourceId').fill('asset-1')
      await page.evaluate(() => {
        const input = document.getElementById('imageUrl') as HTMLInputElement
        input.value = URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>'], { type: 'image/svg+xml' }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await page.locator('#prompt').fill('只调整背景色，保留商品本体')
      await page.locator('details').evaluate((element: HTMLDetailsElement) => { element.open = true })
      await page.locator('#productId').fill('product-1')
      await page.locator('#editorForm button[type="submit"]').click()
      await page.waitForSelector('#candidate.show')
      expect(await page.locator('#candidateId').textContent()).toBe('candidate-from-server')
      expect(await page.locator('#candidateModel').textContent()).toBe('relay-image-edit-v3')
      expect(await page.locator('#regionStatus').textContent()).toContain('候选已创建')
      expect(submittedName).toBe('multimodal.image.edit')
    } finally {
      await page.close()
    }
  }, 15000)

  it('ignores an older workspace order response after the user switches back to mine', async () => {
    const deferred = new Map<string, (value: unknown) => void>()
    const page = await pageWithHost(rechargeHtml, async (name, args) => {
      if (name === 'billing.status') return { structuredContent: { allowed: true, availability: 'available', viewer: { available_scopes: ['workspace'] } } }
      if (name === 'billing.recharge.list') return await new Promise((resolve) => deferred.set(String(args.scope), resolve))
      if (name === 'subscription.orders.list') return { structuredContent: { orders: [] } }
      throw new Error(`Unexpected tool: ${name}`)
    })
    try {
      await page.locator('#tab-orders').click()
      await page.waitForFunction(() => !(document.querySelector('[data-scope="workspace"]') as HTMLButtonElement).hidden)
      await page.getByRole('button', { name: '整个工作区' }).click()
      await waitUntil(() => deferred.has('workspace'))
      await page.getByRole('button', { name: '我的' }).click()
      await waitUntil(() => deferred.has('mine'))
      deferred.get('mine')?.({ structuredContent: { orders: [{ id: 'mine-order', state: 'paid', created_at: '2026-10-10T01:00:00Z', channel: 'wechat' }] } })
      await page.waitForFunction(() => document.getElementById('ordersList')?.textContent?.includes('已到账'))
      deferred.get('workspace')?.({ structuredContent: { orders: [{ id: 'workspace-order', state: 'pending', created_at: '2026-10-10T02:00:00Z', channel: 'wechat' }] } })
      expect(await page.locator('#ordersList').textContent()).toContain('已到账')
      expect(await page.locator('#ordersList').textContent()).not.toContain('待支付')
    } finally {
      await page.close()
    }
  }, 15000)
})

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for deferred host tool call')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
