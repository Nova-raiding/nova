import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_video_brief_boundary'
const taskId = 'task_video_brief_boundary'
const productId = 'product_video_brief_boundary'
const contentVersionId = 'content_video_brief_boundary'
const envelope = data => ({ request_id: 'video-brief-ui-fixture', trace_id: 'video-brief-ui-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })

const task = {
  id: taskId, workspaceId, productId, platform: 'taobao', accountId: 'store-video-brief',
  state: 'content_generated', version: 4, createdAt: '2026-10-10T02:00:00.000Z',
  contentVersionId, selectedDirectionId: 'direction-1', requestText: '为商品准备一份可审阅的营销内容',
}
const product = {
  id: productId, workspaceId, platform: 'taobao', accountId: 'store-video-brief',
  storeName: '合成测试店铺', title: '合成视频 Brief 商品', skuCount: 1, stock: 10,
  factsConfirmed: true, source: 'browser_fixture', version: 2,
}
const contentVersion = {
  id: contentVersionId, taskId, version: 4, revision: 9, state: 'approved', factVersionIds: [], ruleVersionIds: [],
  body: {
    title: '商品内容标题', detail: '商品详情文字由合成 API 返回。', sellingPoints: ['结构清晰'],
    brief: {
      placement: '商品详情页首屏', targetDimensions: '750 × 1000',
      headline: '商品核心特点', subheadline: '让商品信息清晰易读',
      coreSellingPoint: '经确认的商品资料', cta: '了解详情',
      safeArea: '画面中央安全区', protectedAreas: ['商品主体'],
    },
  },
}

test('task content brief is visible without exposing a video creation or render action', async () => {
  test.setTimeout(60_000)
  const vite = await createServer({
    configFile: false, envDir: false, root: studioRoot, plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') {
    await vite.close()
    throw new Error('Video brief UI fixture did not bind an ephemeral TCP port')
  }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' })
  const page = await context.newPage()
  const externalRequests = []
  const pageErrors = []
  const videoRenderRequests = []
  const writeRequests = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== studioUrl) externalRequests.push(url.href)
    if (request.method() !== 'GET' && request.method() !== 'HEAD' && url.pathname.startsWith('/api/v1/')) writeRequests.push(`${request.method()} ${url.pathname}`)
  })
  await page.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== studioUrl) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const path = url.pathname.replace(/^\/api/u, '')
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/v1/auth/session') {
      data = { account: { id: 'video-brief-reader', login: 'video-brief@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    } else if (path === '/v1/auth/mcp-token') {
      data = { access_token: 'video-brief-fixture-token', refresh_token: 'video-brief-fixture-refresh', expires_in: 300, workspace_id: workspaceId }
    } else if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (path === `/v1/tasks/${taskId}`) data = task
    else if (path === `/v1/products/${productId}`) data = product
    else if (path === `/v1/tasks/${taskId}/content-versions`) data = { items: [contentVersion], total: 1, limit: 50, offset: 0 }
    else if (path === `/v1/tasks/${taskId}/feedback`) data = { items: [], total: 0, limit: 50, offset: 0 }
    else if (path === `/v1/tasks/${taskId}/timeline`) data = []
    else if (path === `/v1/tasks/${taskId}/directions`) data = []
    else if (path === `/v1/content-versions/${contentVersionId}/review`) data = { findings: [], categories: [], blocking: false }
    else if (path === '/mcp') {
      const method = request.postDataJSON()?.method
      if (method === 'multimodal.video.request') videoRenderRequests.push(method)
      if (method === 'platform.model.status') data = { result: { state: 'ready', capabilities: { image_generation: false, video_rendering: false } } }
      else if (method === 'workspace.metrics') data = { result: { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} } }
      else data = { result: {} }
    } else if (path.startsWith('/v1/image-generation-jobs') || path.startsWith('/v1/video-generation-jobs')) {
      videoRenderRequests.push(`${request.method()} ${path}`)
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/tasks/${taskId}`, { waitUntil: 'domcontentloaded' })
    const brief = page.locator('.brief-card')
    await expect(page.getByText('创意 Brief（脚本/分镜或静态素材）', { exact: true })).toBeVisible({ timeout: 10_000 })
    await expect(brief).toContainText('商品详情页首屏')
    await expect(brief).toContainText('让商品信息清晰易读')
    await expect(page.getByRole('button', { name: /视频|渲染|分镜生成/u })).toHaveCount(0)
    expect(videoRenderRequests).toEqual([])
    expect(writeRequests).toEqual([])
    expect(pageErrors).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
