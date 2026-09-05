import { expect, test } from '@playwright/test'

test.setTimeout(60_000)
test.use({ channel: 'chrome' })

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:18081/'
const taskWorkspaceUrl = new URL('/merchant/tasks', studioUrl).toString()
const desktopViewports = [
  { width: 1280, height: 900 },
  { width: 1440, height: 1000 },
  { width: 1920, height: 1080 },
]

const envelope = (data, error = null) => ({
  request_id: 'desktop-image-generation-acceptance',
  trace_id: 'desktop-image-generation-acceptance',
  workspace_id: 'ws_demo',
  data,
  warnings: [],
  next_actions: [],
  error,
})

const iso = '2026-08-31T00:00:00.000Z'
const blockedGate = (blocker = '人工审核待审核') => ({
  archive: 'partial',
  scan: 'clean',
  rights: 'pending',
  authenticity: 'unverified',
  selectable: false,
  blockers: [blocker],
})

function partialArchiveJob() {
  const images = Array.from({ length: 6 }, (_, index) => `https://image.test/candidate-${index + 1}.svg`)
  return {
    job_id: 'imgjob-desktop-partial',
    revision: 4,
    state: 'failed',
    archive_state: 'partial',
    product_id: 'prod-desktop-acceptance',
    task_id: null,
    content_version_id: null,
    image_mode: 'create',
    direction: '仅用于桌面归档状态观测',
    requested_count: images.length,
    source_asset_ids: ['asset-desktop-1'],
    source_product_version: 3,
    intent_hash: 'a'.repeat(64),
    execution_state: 'outcome_unknown',
    provider_request_id: 'provider-status-pending',
    execution_attempt: 1,
    reconciliation_required: true,
    error_code: 'IMAGE_GENERATION_ARCHIVE_PARTIAL',
    error_message: '部分候选归档未完成，等待补偿',
    updated_at: iso,
    created_at: iso,
    outputs: images.map((_, index) => ({
      visual_ref: `visual-desktop-${index + 1}`,
      ordinal: index + 1,
      asset_id: `asset-desktop-${index + 1}`,
      archive_receipt_id: null,
      archive_receipt_digest: null,
      storage_key: `quarantine/ws_demo/imgjob-desktop-partial/candidate-${index + 1}.svg`,
      mime_type: 'image/svg+xml',
      size_bytes: 256,
      sha256: String(index + 1).repeat(64),
      created_at: iso,
      review_status: 'unreviewed',
      gate: blockedGate(),
    })),
    images,
    availability_warning: '候选仅用于归档状态核对，未通过全部门禁，不可选择或发布。',
    next_action: { type: 'reconcile', label: '进入运营台对账', allowed: true },
  }
}

function imageJobPath(jobId) {
  return `/api/v1/image-generation-jobs/${jobId}`
}

async function openImageJob(page, jobId) {
  await page.goto(`${taskWorkspaceUrl}?image_job=${encodeURIComponent(jobId)}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: '图片生成任务', exact: true })).toBeVisible()
}

for (const viewport of desktopViewports) {
  test.describe(`${viewport.width}px desktop image task`, () => {
    test.use({ viewport })

    test('shows a loading placeholder while the real task request is pending', async ({ page }) => {
      let release
      const pending = new Promise(resolve => { release = resolve })
      await page.route(`**${imageJobPath('imgjob-loading')}`, async route => {
        await pending
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope({
          job_id: 'imgjob-loading', revision: 1, state: 'queued', archive_state: 'pending', product_id: 'prod-loading',
          task_id: null, content_version_id: null, image_mode: 'create', direction: '等待执行', requested_count: 1,
          source_asset_ids: [], source_product_version: 1, intent_hash: 'b'.repeat(64), execution_state: 'provider_reserved',
          provider_request_id: null, execution_attempt: 1, reconciliation_required: false, error_code: null, error_message: null,
          updated_at: iso, created_at: iso, outputs: [], images: [], availability_warning: null,
          next_action: { type: 'refresh_status', label: '刷新任务状态', allowed: true },
        })) })
      })

      await openImageJob(page, 'imgjob-loading')
      await expect(page.locator('.image-candidate-loading')).toBeVisible()
      await expect(page.locator('.image-candidate-skeleton')).toHaveCount(3)
      await expect(page.locator('.image-generation-job-panel')).toHaveAttribute('aria-busy', 'true')
      release()
      await expect(page.locator('.image-candidate-loading')).toBeHidden()
    })

    test('shows the real empty state without creating demo image tasks', async ({ page }) => {
      await page.route('**/api/v1/image-generation-jobs?limit=50&offset=0', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(envelope({ items: [], total: 0, limit: 50, offset: 0 })),
      }))
      await page.goto(taskWorkspaceUrl, { waitUntil: 'domcontentloaded' })
      await expect(page.getByRole('heading', { name: '图片任务', exact: true })).toBeVisible()
      await expect(page.getByText('暂无图片任务', { exact: true })).toBeVisible()
      await expect(page.getByText('系统不会自动创建演示任务', { exact: false })).toBeVisible()
      await expect(page.locator('.image-generation-job-row')).toHaveCount(0)
    })

    test('shows a visible recoverable error for a failed task read', async ({ page }) => {
      await page.route(`**${imageJobPath('imgjob-failure')}`, route => route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify(envelope(null, { code: 'IMAGE_GENERATION_READ_UNAVAILABLE', message: '任务状态服务暂时不可用' })),
      }))
      await openImageJob(page, 'imgjob-failure')
      const error = page.locator('#image-job-read-error')
      await expect(error).toBeVisible()
      await expect(error).toContainText('任务状态读取失败')
      await expect(error).toContainText('任务状态服务暂时不可用')
      await expect(error).toBeFocused()
      await expect(error.getByRole('button', { name: '刷新任务状态' })).toBeEnabled()
      await expect(page.locator('.image-candidate-grid')).toHaveCount(0)
    })

    test('keeps partial-archive candidates blocked, lazy-loads below-fold images, and reserves layout space', async ({ page }) => {
      const job = partialArchiveJob()
      await page.route(`**${imageJobPath(job.job_id)}`, route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(envelope(job)),
      }))
      await page.route('https://image.test/**', async route => {
        const candidate = route.request().url().match(/candidate-(\d+)\.svg/u)?.[1]
        if (candidate === '3') {
          await route.fulfill({ status: 404, contentType: 'text/plain', body: 'image unavailable' })
          return
        }
        await new Promise(resolve => setTimeout(resolve, 80))
        await route.fulfill({
          status: 200,
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 3"><rect width="4" height="3" fill="#dce8e2"/></svg>',
        })
      })

      await openImageJob(page, job.job_id)
      await expect(page.getByText('部分归档，等待补偿', { exact: true })).toBeVisible()
      await expect(page.getByText('结果尚未确认；请先对账', { exact: false })).toBeVisible()
      await expect(page.getByText('不可选择：人工审核待审核', { exact: true }).first()).toBeVisible()
      await expect(page.getByRole('checkbox')).toHaveCount(0)

      const images = page.locator('.image-candidate-grid img')
      await expect(images).toHaveCount(5)
      await expect(images.first()).toHaveAttribute('loading', 'eager')
      await expect(images.nth(1)).toHaveAttribute('loading', 'lazy')
      await expect(images.nth(1)).toHaveAttribute('fetchpriority', 'low')
      await expect(page.getByRole('alert').filter({ hasText: '候选图片读取失败' })).toBeVisible()
      await expect(page.getByRole('button', { name: '重新读取图片候选 3' })).toBeVisible()

      const before = await page.locator('.image-candidate-grid figure').evaluateAll(items => items.map(item => item.getBoundingClientRect().height))
      await page.waitForTimeout(250)
      const after = await page.locator('.image-candidate-grid figure').evaluateAll(items => items.map(item => item.getBoundingClientRect().height))
      expect(before.length).toBeGreaterThan(0)
      expect(Math.max(...before.map((height, index) => Math.abs(height - (after[index] ?? height))))).toBeLessThan(2)

      const cumulativeLayoutShift = await page.evaluate(() => performance.getEntriesByType('layout-shift').reduce((sum, entry) => sum + (entry.value ?? 0), 0))
      expect(cumulativeLayoutShift).toBeLessThan(0.1)
    })
  })
}
