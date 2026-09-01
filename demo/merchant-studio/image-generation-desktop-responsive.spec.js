import { expect, test, chromium } from '@playwright/test'

test.setTimeout(60_000)

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:18081'
const longJobId = `img_job_${'opaque-long-job-id-'.repeat(12)}`

const envelope = (data) => ({
  request_id: 'responsive-image-request',
  trace_id: 'responsive-image-trace',
  workspace_id: 'ws_demo',
  data,
  warnings: [],
  next_actions: [],
  error: null,
})

const job = {
  job_id: longJobId,
  revision: 8,
  state: 'succeeded',
  archive_state: 'archived',
  product_id: 'product_with_a_long_but_valid_identifier_001',
  task_id: 'task_responsive_001',
  content_version_id: 'content_responsive_001',
  image_mode: 'create',
  direction: '干净背景',
  requested_count: 4,
  source_asset_ids: ['source_asset_1', 'source_asset_2'],
  source_product_version: 12,
  intent_hash: 'a'.repeat(64),
  execution_state: 'succeeded',
  provider_request_id: `provider_request_${'x'.repeat(96)}`,
  execution_attempt: 1,
  reconciliation_required: false,
  error_code: null,
  error_message: null,
  updated_at: '2026-09-01T08:00:00.000Z',
  created_at: '2026-09-01T07:59:00.000Z',
  images: [1, 2, 3, 4].map((index) => `https://assets.example.test/responsive-${index}.svg`),
  outputs: [1, 2, 3, 4].map((index) => ({
    visual_ref: `visual_responsive_${index}_${'v'.repeat(32)}`,
    ordinal: index,
    asset_id: `asset_generated_${index}`,
    archive_receipt_id: `archive_receipt_${index}`,
    archive_receipt_digest: 'b'.repeat(64),
    storage_key: `clean/ws_demo/${'opaque-storage-key-'.repeat(8)}${index}.webp`,
    mime_type: 'image/webp',
    size_bytes: 2048,
    sha256: 'c'.repeat(64),
    created_at: '2026-09-01T08:00:00.000Z',
    review_status: 'passed',
    gate: {
      archive: 'archived',
      scan: 'clean',
      rights: 'approved',
      authenticity: 'verified',
      selectable: true,
      blockers: [],
    },
  })),
  availability_warning: null,
  next_action: { type: 'select', label: '选择主图', allowed: true },
}

async function installRoutes(page) {
  await page.route('**/healthz', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ status: 'ok', writesEnabled: true, connectors: {}, persistence: { mode: 'postgres', ready: true } })),
  }))
  await page.route('**/v1/image-generation-jobs/*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope(job)),
  }))
  await page.route('**/v1/image-generation-jobs?*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ items: [], total: 0, limit: 50, offset: 0 })),
  }))
  await page.route('**/v1/tasks?*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ items: [], total: 0, limit: 12, offset: 0 })),
  }))
  await page.route('**/v1/tasks/task_responsive_001/content-versions*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope([{ id: 'content_responsive_001', revision: 8, version: 12, state: 'review_required' }])),
  }))
  await page.route('**/v1/task-groups*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ items: [], total: 0, limit: 50, offset: 0 })),
  }))
  await page.route('**/v1/workspaces/*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ items: [] })),
  }))
  await page.route('**/responsive-*.svg', (route) => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>',
  }))
  await page.route('**/mcp', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ state: 'ready', capabilities: { image_generation: true } })),
  }))
}

async function openResponsivePage(viewport, reducedMotion = false) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport, reducedMotion: reducedMotion ? 'reduce' : 'no-preference' })
  context.setDefaultTimeout(10_000)
  const page = await context.newPage()
  await installRoutes(page)
  await page.goto(`${studioUrl}/merchant/tasks?image_job=${encodeURIComponent(longJobId)}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: '图片生成任务' })).toBeVisible()
  await expect(page.getByRole('img', { name: /图片候选 1/ })).toBeVisible()
  return { browser, context, page }
}

for (const width of [1280, 1920]) {
  test(`desktop ${width}px has no horizontal overflow and wraps opaque IDs`, async () => {
    const { browser, context, page } = await openResponsivePage({ width, height: 1000 })
    try {
      const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }))
      expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth)

      const metadata = page.locator('.image-candidate-metadata').first()
      await expect(metadata).toBeVisible()
      const longId = metadata.locator('span').first()
      await expect(longId).toContainText(longJobId)
      const layout = await longId.evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          height: element.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(style.lineHeight),
          overflowWrap: style.overflowWrap,
          wordBreak: style.wordBreak,
          whiteSpace: style.whiteSpace,
        }
      })
      expect(layout.height).toBeGreaterThan(layout.lineHeight)
      expect(layout.overflowWrap).toBe('anywhere')
      expect(layout.whiteSpace).toBe('normal')
    } finally {
      await context.close()
      await browser.close()
    }
  })
}

test('reduced motion disables image panel transitions and animations', async () => {
  const { browser, context, page } = await openResponsivePage({ width: 1280, height: 1000 }, true)
  try {
    const motion = await page.locator('.image-generation-job-panel').evaluate((panel) => {
      const elements = [panel, ...panel.querySelectorAll('*')]
      return elements.map((element) => {
        const style = getComputedStyle(element)
        return { transition: style.transitionDuration, animation: style.animationDuration }
      })
    })
    expect(motion.every(({ transition }) => Number.parseFloat(transition) <= 0.01)).toBe(true)
    expect(motion.every(({ animation }) => Number.parseFloat(animation) <= 0.01)).toBe(true)
  } finally {
    await context.close()
    await browser.close()
  }
})
