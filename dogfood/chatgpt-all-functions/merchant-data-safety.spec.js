import { expect, test } from '@playwright/test'

test.setTimeout(60_000)
test.use({ channel: 'chrome' })

const appUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:18081/'
const envelope = (data, error = null) => ({
  request_id: 'merchant-data-safety-test',
  trace_id: 'merchant-data-safety-test',
  workspace_id: 'ws_demo',
  data,
  warnings: [],
  next_actions: [],
  error,
})
const fulfillJson = (route, data, status = 200, error = null) => route.fulfill({
  status,
  contentType: 'application/json',
  body: JSON.stringify(envelope(data, error)),
})
const fulfillPageJson = (route, items, status = 200, error = null) => {
  const requestUrl = new URL(route.request().url())
  const limit = Number(requestUrl.searchParams.get('limit') ?? Math.max(items.length, 1))
  const offset = Number(requestUrl.searchParams.get('offset') ?? 0)
  return fulfillJson(route, { items, total: items.length, limit, offset }, status, error)
}
const product = {
  id: 'prod-safe', workspaceId: 'ws_demo', platform: 'taobao', accountId: 'store-a', storeName: '淘宝 A 店',
  title: '安全测试商品', skuCount: 1, stock: 8, factsConfirmed: true, source: 'official_api', canonical_scope: { verification_status: 'verified', read_mode: 'canonical_read', canonical_product_id: 'canonical-safe' }, createdAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:00.000Z',
}
const sameNameProducts = [
  { ...product, id: 'prod-store-a', accountId: 'store-a', storeName: '淘宝 A 店', title: '同名双店商品' },
  { ...product, id: 'prod-store-b', accountId: 'store-b', storeName: '淘宝 B 店', title: '同名双店商品', stock: 12 },
]

const finalPublishProduct = { ...product, id: 'prod-final-publish', accountId: 'store-final', storeName: '家居终审店', title: '厨房置物架' }
const finalPublishTask = { id: 'task-final-publish', workspaceId: 'ws_demo', productId: finalPublishProduct.id, platform: 'taobao', accountId: finalPublishProduct.accountId, state: 'approved', selectedDirectionId: 'KITCHEN-FINAL', version: 8, contentVersionId: 'content-final-v7', createdAt: '2026-08-28T00:00:00.000Z' }
const finalPublishContent = { id: 'content-final-v7', taskId: finalPublishTask.id, version: 7, body: { title: '厨房置物架终审标题', detail: '真实详情', sellingPoints: ['分层收纳'], modules: [] }, factVersionIds: ['fact-kitchen'], ruleVersionIds: ['rule-kitchen'], state: 'approved', revision: 3 }
const finalPublishPreview = { task: finalPublishTask, version: finalPublishContent, remoteSnapshotHash: 'snapshot-kitchen-final-v7', confirmationHash: 'confirmation-kitchen-final-v7', operation: 'update', changes: ['title', 'detail'], protectedFields: ['price', 'stock', 'sku'] }

const singleTaskUnderstanding = productId => ({
  requestText: '准备商品详情页营销内容',
  platformCandidates: ['taobao'],
  productCandidates: [],
  extracted: { goal: '商品详情页营销内容' },
  questions: [],
  executionPlan: { mode: 'single_task', canCreate: true, reason: '当前商品已绑定单一平台和店铺', childTasks: [{ platform: 'taobao', candidateProductIds: [productId], bindingState: 'ready' }] },
})

async function confirmTaskFromConversation(page, productId, requestText = '准备商品详情页营销内容', taskUnderstanding = singleTaskUnderstanding(productId)) {
  await page.route('**/api/v1/tasks/understand', route => fulfillJson(route, { ...taskUnderstanding, requestText }))
  const request = page.getByRole('textbox', { name: '描述你的营销任务' })
  await request.fill(requestText)
  await request.press('Enter')
  await expect(page.getByTestId('task-create-confirmation')).toBeVisible()
  await expect(request).toBeFocused()
  await page.getByRole('button', { name: '确认需求并创建任务' }).click()
}

test('model relay readiness is visible before a merchant starts a task', async ({ page }) => {
  await page.route('**/api/mcp', async route => {
    const request = route.request().postDataJSON()
    if (request?.method !== 'platform.model.status') return route.continue()
    return fulfillJson(route, { result: {
      state: 'model_relay_blocked',
      relay: { configured: false, host: null, reasons: ['缺少真实模型中转配置'] },
      capabilities: { text_generation: false, image_generation: false, image_editing: false, image_fact_ocr: false, video_rendering: false },
      next_actions: ['配置平台模型中转站后重新检查'],
      cost_control_ready: false,
      cost_evidence_ready: false,
      release_metadata_ready: true,
    } })
  })
  await page.goto(appUrl)
  await expect(page.locator('.environment-banner')).toContainText('模型中转未就绪')
  await page.getByRole('button', { name: '查看系统健康' }).click()
  const health = page.getByRole('dialog', { name: '系统健康' })
  await expect(health).toContainText('模型中转：未就绪，服务端会阻止生成')
  await expect(health).toContainText('配置平台模型中转站后重新检查')
})

async function openFinalPublishConfirmation(page, publishRoute) {
  await page.route(/\/api\/v1\/products(?:\?.*)?$/, route => fulfillPageJson(route, [finalPublishProduct]))
  await page.route('**/api/v1/products/prod-final-publish', route => fulfillJson(route, finalPublishProduct))
  await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, route => fulfillPageJson(route, [finalPublishTask]))
  await page.route('**/api/v1/tasks/task-final-publish', route => fulfillJson(route, finalPublishTask))
  await page.route('**/api/v1/tasks/task-final-publish/content-versions**', route => fulfillJson(route, [finalPublishContent]))
  await page.route('**/api/v1/tasks/task-final-publish/directions', route => fulfillJson(route, [{ id: 'KITCHEN-FINAL', name: '厨房终审方向', coreIdea: '真实收纳事实', structure: '事实结构', copyDirection: '事实文案', visualDirection: '真实图片', sellingPoints: ['分层收纳'], fitReason: '厨房事实', risk: '无' }]))
  await page.route('**/api/v1/tasks/task-final-publish/feedback**', route => fulfillJson(route, []))
  await page.route('**/api/v1/tasks/task-final-publish/timeline', route => fulfillJson(route, []))
  await page.route('**/api/v1/content-versions/content-final-v7/review', route => fulfillJson(route, { findings: [], categories: [], blocking: false }))
  await page.route('**/api/v1/tasks/task-final-publish/publish-preview', route => fulfillJson(route, finalPublishPreview))
  await page.route('**/api/v1/publish-jobs**', publishRoute)

  await page.goto(appUrl)
  await page.getByRole('button', { name: '营销任务', exact: true }).first().click()
  await page.getByRole('button', { name: /查看结果|恢复任务/ }).click()
  await expect(page.getByText('厨房置物架 · 淘宝 · 家居终审店', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /进入发布|继续确认发布/ }).click()
  const dialog = page.getByRole('dialog', { name: /确认更新淘宝商品/ })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('checkbox').check()
  return dialog
}

test('final publish confirms once, binds all evidence, shows the real job id, and opens publish center', async ({ page }) => {
  const requests = []
  let acceptedJob
  let release
  const gate = new Promise(resolve => { release = resolve })
  const dialog = await openFinalPublishConfirmation(page, async route => {
    if (route.request().method() === 'GET') return fulfillJson(route, acceptedJob ? [acceptedJob] : [])
    const idempotencyKey = await route.request().headerValue('idempotency-key')
    requests.push({ body: route.request().postDataJSON(), idempotencyKey })
    acceptedJob = { id: 'publish-job-real-742', workspaceId: 'ws_demo', taskId: finalPublishTask.id, contentVersionId: finalPublishContent.id, platform: 'taobao', accountId: finalPublishProduct.accountId, idempotencyKey, state: 'queued', confirmationHash: finalPublishPreview.confirmationHash, remoteSnapshotHash: finalPublishPreview.remoteSnapshotHash, createdAt: '2026-08-28T00:00:00.000Z' }
    await gate
    return fulfillJson(route, acceptedJob, 202)
  })

  const confirmButton = dialog.locator('button.danger-action')
  await confirmButton.evaluate(button => { button.click(); button.click() })
  await expect(confirmButton).toBeDisabled()
  await expect(confirmButton).toContainText('正在安全提交')
  await expect.poll(() => requests.length).toBe(1)
  release()

  await expect(page.getByRole('status').filter({ hasText: 'publish-job-real-742' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '每一次线上变更都有确认和回执' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'publish-job-real-742' })).toBeVisible()
  expect(requests[0].body).toEqual({ task_id: finalPublishTask.id, content_version_id: finalPublishContent.id, account_id: finalPublishProduct.accountId, confirmation_hash: finalPublishPreview.confirmationHash, remote_snapshot_hash: finalPublishPreview.remoteSnapshotHash })
  expect(requests[0].idempotencyKey).toContain('merchant-studio-publish-v1:')
  expect(acceptedJob.idempotencyKey).toBe(requests[0].idempotencyKey)
})

test('500 keeps confirmation recoverable and replay uses one idempotency intent', async ({ page }) => {
  const keys = []
  const jobsByKey = new Map()
  let attempts = 0
  const dialog = await openFinalPublishConfirmation(page, async route => {
    if (route.request().method() === 'GET') return fulfillJson(route, [...jobsByKey.values()])
    attempts += 1
    const key = await route.request().headerValue('idempotency-key')
    keys.push(key)
    const job = jobsByKey.get(key) ?? { id: 'publish-job-replayed-500', workspaceId: 'ws_demo', taskId: finalPublishTask.id, contentVersionId: finalPublishContent.id, platform: 'taobao', accountId: finalPublishProduct.accountId, idempotencyKey: key, state: 'queued', confirmationHash: finalPublishPreview.confirmationHash, remoteSnapshotHash: finalPublishPreview.remoteSnapshotHash, createdAt: '2026-08-28T00:00:00.000Z' }
    jobsByKey.set(key, job)
    if (attempts === 1) return fulfillJson(route, null, 500, { code: 'PUBLISH_RESPONSE_LOST', message: '发布响应丢失' })
    return fulfillJson(route, job, 202)
  })

  await dialog.getByRole('button', { name: '确认更新淘宝商品' }).click()
  const error = dialog.getByRole('alert').filter({ hasText: '发布响应丢失' })
  await expect(error).toBeVisible()
  await expect(error).toBeFocused()
  await expect(dialog.getByRole('checkbox')).toBeChecked()
  await expect(page.getByText(/发布请求已受理/)).toHaveCount(0)
  await dialog.getByRole('button', { name: '重新安全提交' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'publish-job-replayed-500' })).toBeVisible()
  expect(attempts).toBe(2)
  expect(new Set(keys).size).toBe(1)
  expect(jobsByKey.size).toBe(1)
})

test('publish timeout never shows success and retry preserves confirmation and idempotency', async ({ page }) => {
  const keys = []
  let attempts = 0
  let acceptedJob
  const dialog = await openFinalPublishConfirmation(page, async route => {
    if (route.request().method() === 'GET') return fulfillJson(route, acceptedJob ? [acceptedJob] : [])
    attempts += 1
    const key = await route.request().headerValue('idempotency-key')
    keys.push(key)
    if (attempts === 1) {
      await new Promise(resolve => setTimeout(resolve, 11_000))
      return fulfillJson(route, null, 504, { code: 'LATE_RESPONSE', message: 'late' }).catch(() => undefined)
    }
    acceptedJob = { id: 'publish-job-after-timeout', workspaceId: 'ws_demo', taskId: finalPublishTask.id, contentVersionId: finalPublishContent.id, platform: 'taobao', accountId: finalPublishProduct.accountId, idempotencyKey: key, state: 'queued', confirmationHash: finalPublishPreview.confirmationHash, remoteSnapshotHash: finalPublishPreview.remoteSnapshotHash, createdAt: '2026-08-28T00:00:00.000Z' }
    return fulfillJson(route, acceptedJob, 202)
  })

  await dialog.getByRole('button', { name: '确认更新淘宝商品' }).click()
  const error = dialog.getByRole('alert').filter({ hasText: 'API 请求超时' })
  await expect(error).toBeVisible({ timeout: 15_000 })
  await expect(error).toBeFocused()
  await expect(dialog.getByRole('checkbox')).toBeChecked()
  await expect(page.getByText(/发布请求已受理/)).toHaveCount(0)
  await dialog.getByRole('button', { name: '重新安全提交' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'publish-job-after-timeout' })).toBeVisible()
  expect(new Set(keys).size).toBe(1)
})

test('non-fashion draft task renders only server direction, server state, and explicit missing rules', async ({ page }) => {
  const kitchenProduct = { ...product, id: 'prod-kitchen', accountId: 'store-kitchen', storeName: '家居 A 店', title: '厨房收纳盒', category: '厨房收纳', attributes: { 材质: 'PP', 用途: '厨房收纳' } }
  const draftTask = { id: 'task-kitchen', workspaceId: 'ws_demo', productId: kitchenProduct.id, platform: 'taobao', accountId: kitchenProduct.accountId, state: 'draft', version: 1, createdAt: '2026-08-28T00:00:00.000Z', missingQuestions: [] }
  const serverDirection = { id: 'KITCHEN-TRUTH', name: '收纳动线说明', coreIdea: '只描述服务端确认的厨房收纳用途。', structure: '问题到方案', copyDirection: '事实说明', visualDirection: '真实商品图', sellingPoints: ['分区收纳'], fitReason: '厨房收纳商品事实', risk: '避免扩展材质功效' }

  await page.route(/\/api\/v1\/products(?:\?.*)?$/, route => fulfillPageJson(route, [kitchenProduct]))
  await page.route('**/api/v1/products/prod-kitchen', route => fulfillJson(route, kitchenProduct))
  await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, route => route.request().method() === 'POST' ? fulfillJson(route, draftTask) : fulfillPageJson(route, []))
  await page.route('**/api/v1/tasks/task-kitchen/directions', route => fulfillJson(route, [serverDirection]))
  await page.route('**/api/v1/tasks/understand', route => fulfillJson(route, singleTaskUnderstanding(kitchenProduct.id)))

  await page.goto(appUrl)
  await page.getByRole('button', { name: '商品与资产', exact: true }).first().click()
  await page.locator('tbody tr').filter({ hasText: '厨房收纳盒' }).getByRole('button', { name: /创建任务/ }).click()
  await confirmTaskFromConversation(page, kitchenProduct.id)

  await expect(page.getByText('厨房收纳盒 · 淘宝 · 家居 A 店', { exact: true })).toBeVisible()
  await expect(page.getByText('收纳动线说明', { exact: true })).toBeVisible()
  await expect(page.locator('.direction-letter')).toHaveText(['KITCHEN-TRUTH'])
  await expect(page.getByText('展示真实外观', { exact: true })).toHaveCount(0)
  await expect(page.getByText('规格信息清晰', { exact: true })).toHaveCount(0)
  await expect(page.getByText('守住事实边界', { exact: true })).toHaveCount(0)

  const workflow = page.getByTestId('task-workflow-stepper').locator(':scope > div')
  await expect(workflow.nth(0)).toHaveAttribute('data-step-status', 'current')
  await expect(workflow.nth(1)).toHaveAttribute('data-step-status', 'pending')
  await expect(workflow.nth(2)).toHaveAttribute('data-step-status', 'pending')
  await expect(workflow.nth(3)).toHaveAttribute('data-step-status', 'pending')
  await expect(page.getByTestId('task-rules-empty')).toBeVisible()
  await expect(page.getByText(/100% 防晒/)).toHaveCount(0)
  await expect(page.getByText(/广告法规则包/)).toHaveCount(0)
})

test('API task with no server directions shows an empty state without demo directions', async ({ page }) => {
  const kitchenProduct = { ...product, id: 'prod-kitchen-empty', accountId: 'store-kitchen', storeName: '家居 A 店', title: '厨房收纳盒（无方向）', category: '厨房收纳' }
  const draftTask = { id: 'task-kitchen-empty', workspaceId: 'ws_demo', productId: kitchenProduct.id, platform: 'taobao', accountId: kitchenProduct.accountId, state: 'draft', version: 1, createdAt: '2026-08-28T00:00:00.000Z', missingQuestions: [] }
  await page.route(/\/api\/v1\/products(?:\?.*)?$/, route => fulfillPageJson(route, [kitchenProduct]))
  await page.route('**/api/v1/products/prod-kitchen-empty', route => fulfillJson(route, kitchenProduct))
  await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, route => route.request().method() === 'POST' ? fulfillJson(route, draftTask) : fulfillPageJson(route, []))
  await page.route('**/api/v1/tasks/task-kitchen-empty/directions', route => fulfillJson(route, []))
  await page.route('**/api/v1/tasks/understand', route => fulfillJson(route, singleTaskUnderstanding(kitchenProduct.id)))

  await page.goto(appUrl)
  await page.getByRole('button', { name: '商品与资产', exact: true }).first().click()
  await page.locator('tbody tr').filter({ hasText: '厨房收纳盒（无方向）' }).getByRole('button', { name: /创建任务/ }).click()
  await confirmTaskFromConversation(page, kitchenProduct.id)

  await expect(page.getByTestId('task-directions-empty')).toContainText('服务端尚未生成创意方向')
  await expect(page.locator('.direction-card')).toHaveCount(0)
  await expect(page.getByTestId('task-rules-empty')).toContainText('未展示任何演示规则')
})

test('accepted task answers remain visible in the conversation thread', async ({ page }) => {
  const kitchenProduct = { ...product, id: 'prod-kitchen-reply', accountId: 'store-kitchen', storeName: '家居 A 店', title: '厨房收纳盒（回答留痕）', category: '厨房收纳' }
  const draftTask = { id: 'task-kitchen-reply', workspaceId: 'ws_demo', productId: kitchenProduct.id, platform: 'taobao', accountId: kitchenProduct.accountId, state: 'draft', version: 1, createdAt: '2026-08-28T00:00:00.000Z', missingQuestions: [{ id: 'output_count', prompt: '需要几组内容？', why: '确定交付范围', ifSkipped: '使用服务端默认值', kind: 'blocking' }] }
  const followUpQuestion = { id: 'audience', prompt: '主要面向哪类消费者？', why: '确定表达场景', ifSkipped: '使用通用表达', kind: 'recommended' }
  const answeredTask = { ...draftTask, version: 2, missingQuestions: [followUpQuestion] }
  const deferredTask = { ...answeredTask, version: 3, missingQuestions: [] }
  const understanding = { ...singleTaskUnderstanding(kitchenProduct.id), questions: [{ id: 'output_count', prompt: '需要几组内容？', why: '确定交付范围', ifSkipped: '使用服务端默认值', kind: 'blocking' }] }

  await page.route(/\/api\/v1\/products(?:\?.*)?$/, route => fulfillPageJson(route, [kitchenProduct]))
  await page.route('**/api/v1/products/prod-kitchen-reply', route => fulfillJson(route, kitchenProduct))
  await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, route => route.request().method() === 'POST' ? fulfillJson(route, draftTask) : fulfillPageJson(route, []))
  await page.route('**/api/v1/tasks/understand', route => fulfillJson(route, understanding))
  await page.route('**/api/v1/tasks/task-kitchen-reply', route => fulfillJson(route, draftTask))
  await page.route('**/api/v1/tasks/task-kitchen-reply/answers', route => {
    const body = route.request().postDataJSON()
    return fulfillJson(route, body?.answers?.defer_questions ? deferredTask : answeredTask)
  })
  await page.route('**/api/v1/tasks/task-kitchen-reply/directions', route => fulfillJson(route, []))

  await page.goto(appUrl)
  await page.getByRole('button', { name: '商品与资产', exact: true }).first().click()
  await page.locator('tbody tr').filter({ hasText: '厨房收纳盒（回答留痕）' }).getByRole('button', { name: /创建任务/ }).click()
  await confirmTaskFromConversation(page, kitchenProduct.id, '准备商品详情页营销内容', understanding)
  await expect(page.getByRole('textbox', { name: '描述你的营销任务' })).toHaveAttribute('readonly', '')
  await expect(page.getByRole('button', { name: '重新分析' })).toBeDisabled()

  const answer = page.getByRole('textbox', { name: /需要几组内容/ })
  await answer.fill('3')
  await page.getByRole('button', { name: '回答并继续' }).click()
  await expect(page.getByTestId('conversation-reply-0')).toContainText('需要几组内容？')
  await expect(page.getByTestId('conversation-reply-0')).toContainText('3')
  await expect(page.getByRole('textbox', { name: /主要面向哪类消费者/ })).toBeVisible()
  await page.getByRole('button', { name: '稍后补充' }).click()
  await expect(page.getByTestId('conversation-reply-1')).toContainText('暂存，稍后补充')
})

test('rule and category API failures never reveal demos and independent retries recover real data', async ({ page }) => {
  let rulesMode = 'error'
  let categoriesMode = 'error'
  const realRule = { id: 'rule-real', name: '真实平台规则包', version: 'real-1.0.0', scope: '全平台', status: 'active', revision: 4, updatedAt: '2026-08-28T00:00:00.000Z', source: { reference: '管理员规则中心', checkedAt: '2026-08-28T00:00:00.000Z' } }
  const realCategory = { code: 'real-cat', name: '真实平台类目', fields: ['真实字段'], platforms: ['taobao'], status: 'active', updatedAt: '2026-08-28T00:00:00.000Z' }

  await page.route('**/api/v1/rules*', route => {
    if (rulesMode === 'error') return fulfillJson(route, null, 500, { code: 'RULES_DOWN', message: '规则服务不可用' })
    return fulfillJson(route, [realRule])
  })
  await page.route('**/api/v1/catalog/categories', route => {
    if (categoriesMode === 'error') return fulfillJson(route, null, 500, { code: 'CATEGORIES_DOWN', message: '类目服务不可用' })
    return fulfillJson(route, [realCategory])
  })

  await page.goto(appUrl)
  await page.getByRole('button', { name: '规则与检查', exact: true }).first().click()
  const rulesError = page.getByRole('alert').filter({ hasText: '规则库读取失败' })
  await expect(rulesError).toBeVisible()
  await expect(page.getByText('中国电商广告表达', { exact: true })).toHaveCount(0)
  await expect(page.getByText('真实平台规则包', { exact: true })).toHaveCount(0)

  await page.getByRole('tab', { name: /品类库/ }).click()
  const categoriesError = page.getByRole('alert').filter({ hasText: '品类库读取失败' })
  await expect(categoriesError).toBeVisible()
  await expect(page.getByText('服装 / 防晒外套', { exact: true })).toHaveCount(0)
  await expect(page.getByText('真实平台类目', { exact: true })).toHaveCount(0)

  categoriesMode = 'success'
  await categoriesError.getByRole('button', { name: '重新读取' }).click()
  await expect(page.getByText('真实平台类目', { exact: true })).toBeVisible()
  await expect(page.getByText('服装 / 防晒外套', { exact: true })).toHaveCount(0)

  await page.getByRole('tab', { name: /规则库/ }).click()
  await expect(rulesError).toBeVisible()
  rulesMode = 'success'
  await rulesError.getByRole('button', { name: '重新读取' }).click()
  await expect(page.getByText('真实平台规则包', { exact: true })).toBeVisible()
  await expect(page.getByText('中国电商广告表达', { exact: true })).toHaveCount(0)
})

test('successful empty rule and category APIs show true empty states without demos', async ({ page }) => {
  await page.route('**/api/v1/rules*', route => fulfillJson(route, []))
  await page.route('**/api/v1/catalog/categories', route => fulfillJson(route, []))

  await page.goto(appUrl)
  await page.getByRole('button', { name: '规则与检查', exact: true }).first().click()
  await expect(page.getByTestId('rules-api-empty')).toContainText('API 暂无生效规则包')
  await expect(page.getByText('中国电商广告表达', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)

  await page.getByRole('tab', { name: /品类库/ }).click()
  await expect(page.getByTestId('categories-api-empty')).toContainText('API 暂无类目数据')
  await expect(page.getByText('服装 / 防晒外套', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('API product failure never falls back to fixtures and retry recovers to real products', async ({ page }) => {
  let mode = 'error'
  await page.route(/\/api\/v1\/products(?:\?.*)?$/, route => {
    if (mode === 'error') return fulfillJson(route, null, 503, { code: 'PRODUCTS_DOWN', message: '商品服务不可用' })
    return fulfillPageJson(route, [product])
  })

  await page.goto(appUrl)
  await page.getByRole('button', { name: '商品与资产', exact: true }).first().click()
  const productError = page.getByRole('alert').filter({ hasText: '不会执行任何外部写入' })
  await expect(productError).toBeVisible()
  await expect(page.getByTestId('products-unavailable')).toBeVisible()
  await expect(page.getByText('轻云防晒外套 2026', { exact: true })).toHaveCount(0)
  await expect(page.locator('tbody tr')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /创建任务/ })).toHaveCount(0)

  mode = 'success'
  await productError.getByRole('button', { name: '重新读取' }).click()
  await expect(page.getByText('安全测试商品', { exact: true })).toBeVisible()
  await expect(page.getByText('淘宝 A 店', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /创建任务/ })).toBeEnabled()
  await expect(page.getByTestId('products-unavailable')).toHaveCount(0)
})

test('same-platform same-name selection preserves store identity through task facts and publish confirmation', async ({ page }) => {
  let createBody
  const createdTask = { id: 'task-store-b', workspaceId: 'ws_demo', productId: 'prod-store-b', platform: 'taobao', accountId: 'store-b', state: 'plan_confirmed', selectedDirectionId: 'STORE-B-TRUTH', version: 2, createdAt: '2026-08-28T00:00:00.000Z' }
  const approvedTask = { ...createdTask, state: 'approved', version: 3, contentVersionId: 'content-store-b' }
  const content = { id: 'content-store-b', taskId: createdTask.id, version: 1, body: { title: 'B 店已审核标题', detail: '详情', sellingPoints: ['卖点'], modules: [] }, factVersionIds: ['fact-b'], ruleVersionIds: ['rule-b'], state: 'review_required', revision: 1 }
  const approvedContent = { ...content, state: 'approved', revision: 2 }

  await page.route(/\/api\/v1\/products(?:\?.*)?$/, route => fulfillPageJson(route, sameNameProducts))
  await page.route('**/api/v1/products/prod-store-b', route => fulfillJson(route, sameNameProducts[1]))
  await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, route => {
    if (route.request().method() === 'POST') {
      createBody = route.request().postDataJSON()
      return fulfillJson(route, createdTask)
    }
    return fulfillPageJson(route, [])
  })
  await page.route('**/api/v1/tasks/task-store-b/content-jobs', route => fulfillJson(route, { id: 'generation-store-b', taskId: createdTask.id, state: 'succeeded', attempt: 1, contentVersionId: content.id }))
  await page.route('**/api/v1/tasks/task-store-b/directions', route => fulfillJson(route, [{ id: 'STORE-B-TRUTH', name: 'B 店服务端方向', coreIdea: '仅使用 B 店事实', structure: '服务端结构', copyDirection: '服务端文案', visualDirection: '服务端视觉', sellingPoints: ['卖点'], fitReason: 'B 店事实', risk: '无扩展事实' }]))
  await page.route('**/api/v1/tasks/task-store-b/content-versions**', route => fulfillJson(route, [content]))
  await page.route('**/api/v1/content-versions/content-store-b/review', route => fulfillJson(route, { findings: [], categories: [], blocking: false }))
  await page.route('**/api/v1/tasks/task-store-b/approve', route => fulfillJson(route, { task: approvedTask, version: approvedContent }))
  await page.route('**/api/v1/tasks/task-store-b/publish-preview', route => fulfillJson(route, { task: approvedTask, version: approvedContent, remoteSnapshotHash: 'snapshot-store-b', confirmationHash: 'confirmation-store-b', operation: 'update', changes: ['title'], protectedFields: ['price', 'stock', 'sku'] }))
  await page.route('**/api/v1/tasks/understand', route => fulfillJson(route, singleTaskUnderstanding(sameNameProducts[1].id)))

  await page.goto(appUrl)
  await page.getByRole('button', { name: '商品与资产', exact: true }).first().click()
  const storeBRow = page.locator('tbody tr').filter({ hasText: '淘宝 B 店' })
  await expect(storeBRow).toContainText('同名双店商品')
  await storeBRow.getByRole('button', { name: /创建任务/ }).click()
  await confirmTaskFromConversation(page, sameNameProducts[1].id)

  await expect.poll(() => createBody).toMatchObject({ product_id: 'prod-store-b', platform: 'taobao', account_id: 'store-b' })
  expect(createBody.idempotency_key).toMatch(/^[0-9a-f-]{36}$/u)
  await expect(page.locator('.task-titlebar')).toContainText('同名双店商品 · 淘宝 · 淘宝 B 店')
  await expect(page.locator('.context-product')).toContainText('淘宝 B 店 · 店铺身份已确认')

  await page.getByRole('button', { name: '确认制作方案并生成' }).click()
  await expect(page.getByText('B 店已审核标题', { exact: true }).first()).toBeVisible()
  await expect(page.getByTestId('task-rule-evidence')).toContainText('服务端规则版本已绑定')
  await expect(page.getByText(/100% 防晒/)).toHaveCount(0)
  const approval = page.getByLabel('我已核对事实、规则和最终内容')
  await approval.click()
  await expect(approval).toBeChecked()
  await expect(page.getByRole('button', { name: /继续确认发布/ })).toBeEnabled()
  await page.getByRole('button', { name: /继续确认发布/ }).click()
  const dialog = page.getByRole('dialog', { name: /确认更新淘宝商品/ })
  await expect(dialog).toContainText('淘宝 B 店 · 店铺身份已确认')
  await expect(dialog).toContainText('写入店铺“淘宝 B 店”')
  await expect(dialog).not.toContainText('淘宝 A 店')
})

test('missing or changed store identity blocks same-name task creation', async ({ page }) => {
  let productMode = 'initial'
  let createRequests = 0
  const missingIdentity = { ...sameNameProducts[0], id: 'prod-missing', accountId: undefined }
  await page.route(/\/api\/v1\/products(?:\?.*)?$/, route => {
    if (productMode === 'initial') return fulfillPageJson(route, [missingIdentity, sameNameProducts[1]])
    return fulfillPageJson(route, [missingIdentity, { ...sameNameProducts[1], accountId: 'store-a', storeName: '淘宝 A 店' }])
  })
  await page.route('**/api/v1/products/prod-store-b', route => productMode === 'initial'
    ? fulfillJson(route, sameNameProducts[1])
    : fulfillJson(route, { ...sameNameProducts[1], accountId: 'store-a', storeName: '淘宝 A 店' }))
  await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, route => {
    if (route.request().method() === 'POST') createRequests += 1
    return fulfillPageJson(route, [])
  })

  await page.goto(appUrl)
  await page.getByRole('button', { name: '商品与资产', exact: true }).first().click()
  const missingRow = page.locator('tbody tr').filter({ hasText: '目标商品缺少完整店铺身份' })
  await expect(missingRow.getByRole('button', { name: /创建任务/ })).toBeDisabled()

  const storeBRow = page.locator('tbody tr').filter({ hasText: '淘宝 B 店' })
  await expect(storeBRow).toBeVisible()
  productMode = 'mismatch'
  await storeBRow.getByRole('button', { name: /创建任务/ }).click()
  await expect(page.getByRole('alert', { name: '这项任务暂时无法继续' })).toBeVisible()
  await expect.poll(() => createRequests).toBe(0)
  await expect(page.getByRole('button', { name: /进入已审核任务发布|进入发布/, exact: true })).toHaveCount(0)
})

test('task list shows loading, then a true empty state only after a successful response', async ({ page }) => {
  let release
  const responseGate = new Promise(resolve => { release = resolve })
  await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, async route => { await responseGate; await fulfillPageJson(route, []) })
  await page.route(/\/api\/v1\/products(?:\?.*)?$/, route => fulfillPageJson(route, []))

  await page.goto(appUrl)
  await page.getByRole('button', { name: '营销任务', exact: true }).first().click()
  await expect(page.getByText('正在读取营销任务…', { exact: true })).toBeVisible()
  await expect(page.getByText('暂无营销任务', { exact: true })).toHaveCount(0)

  release()
  await expect(page.getByText('暂无营销任务', { exact: true })).toBeVisible()
  await expect(page.getByText('正在读取营销任务…', { exact: true })).toHaveCount(0)
})

test('task list keeps error distinct from empty and retry can recover to data', async ({ page }) => {
  let mode = 'error'
  await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, route => {
    if (mode === 'error') return fulfillJson(route, null, 500, { code: 'TASK_LIST_FAILED', message: '任务列表读取失败' })
    return fulfillPageJson(route, [{ id: 'task-safe', workspaceId: 'ws_demo', productId: product.id, platform: 'taobao', accountId: 'store-a', state: 'draft', version: 1, createdAt: '2026-08-28T00:00:00.000Z' }])
  })
  await page.route(/\/api\/v1\/products(?:\?.*)?$/, route => fulfillPageJson(route, [product]))
  await page.route('**/api/v1/products/prod-safe', route => fulfillJson(route, product))

  await page.goto(appUrl)
  await page.getByRole('button', { name: '营销任务', exact: true }).first().click()
  await expect(page.getByRole('alert').filter({ hasText: '任务列表读取失败' })).toBeVisible()
  await expect(page.getByText('暂无营销任务', { exact: true })).toHaveCount(0)
  mode = 'success'
  await page.getByRole('alert').filter({ hasText: '任务列表读取失败' }).getByRole('button', { name: '重新读取' }).last().click()
  await expect(page.getByRole('button', { name: /继续任务|恢复任务/ })).toBeVisible()
  await expect(page.getByText('1 个任务', { exact: true })).toBeVisible()
})

test('task list remains visible when auxiliary product identity fails and retry recovers', async ({ page }) => {
  let productMode = 'error'
  const productModesSeen = []
  const task = { id: 'task-aux-safe', workspaceId: 'ws_demo', productId: product.id, platform: 'taobao', accountId: 'store-a', state: 'draft', version: 1, createdAt: '2026-08-28T00:00:00.000Z' }
  await page.route(/\/api\/v1\/tasks(?:\?.*)?$/, route => fulfillPageJson(route, [task]))
  await page.route('**/api/v1/products/prod-safe', route => {
    productModesSeen.push(productMode)
    if (productMode === 'error') {
      return fulfillJson(route, null, 503, { code: 'PRODUCT_IDENTITY_UNAVAILABLE', message: '商品身份服务不可用' })
    }
    return fulfillJson(route, product)
  })

  await page.goto(appUrl)
  await page.getByRole('button', { name: '营销任务', exact: true }).first().click()
  const taskRow = page.locator('.task-list-row').first()
  await expect(page.getByText('1 个任务', { exact: true })).toBeVisible()
  await expect(taskRow).toBeVisible()
  await expect(page.getByText('正在读取营销任务…', { exact: true })).toHaveCount(0)

  const auxiliaryError = page.getByRole('alert').filter({ hasText: '商品与店铺身份读取失败' })
  await expect(auxiliaryError).toBeVisible()
  await expect(taskRow).toBeVisible()
  await expect(page.getByText('身份读取失败', { exact: true })).toBeVisible()
  await expect(page.getByText('暂无营销任务', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /继续任务|恢复任务/ })).toBeDisabled()

  productMode = 'success'
  await auxiliaryError.getByRole('button', { name: '重新读取' }).click()
  await expect.poll(() => productModesSeen).toContain('success')
  await expect(taskRow).toContainText('安全测试商品')
  await expect(taskRow).toContainText('淘宝 A 店')
  await expect(page.getByRole('button', { name: /继续任务|恢复任务/ })).toBeEnabled()
  await expect(auxiliaryError).toHaveCount(0)
})

test('publish lists show loading and never render empty while the request failed', async ({ page }) => {
  let release
  let mode = 'error'
  const responseGate = new Promise(resolve => { release = resolve })
  await page.route('**/api/v1/publish-jobs**', async route => {
    if (mode === 'error') {
      await responseGate
      return fulfillJson(route, null, 500, { code: 'PUBLISH_LIST_FAILED', message: '发布任务读取失败' })
    }
    return fulfillJson(route, [])
  })

  await page.goto(appUrl)
  await page.getByRole('button', { name: '发布中心', exact: true }).first().click()
  await expect(page.getByText('正在读取发布任务…', { exact: true })).toBeVisible()
  await expect(page.getByText('暂无真实发布任务', { exact: true })).toHaveCount(0)

  release()
  await expect(page.getByRole('alert').filter({ hasText: '发布任务读取失败' })).toBeVisible()
  await expect(page.getByText('暂无真实发布任务', { exact: true })).toHaveCount(0)
  await expect(page.getByText('暂无回执', { exact: true })).toHaveCount(0)

  mode = 'empty'
  await page.getByRole('alert').getByRole('button', { name: '重新读取' }).click()
  await expect(page.getByText('暂无真实发布任务', { exact: true })).toBeVisible()
  await expect(page.getByText('暂无回执', { exact: true })).toBeVisible()
})

test('publish list renders successful jobs after loading', async ({ page }) => {
  await page.route('**/api/v1/publish-jobs**', route => fulfillJson(route, [{
    id: 'publish-safe', workspaceId: 'ws_demo', taskId: 'task-safe', contentVersionId: 'content-safe', platform: 'taobao',
    idempotencyKey: 'safe', state: 'published', confirmationHash: 'confirm', remoteSnapshotHash: 'snapshot', remoteState: 'ONLINE', createdAt: '2026-08-28T00:00:00.000Z',
  }]))

  await page.goto(appUrl)
  await page.getByRole('button', { name: '发布中心', exact: true }).first().click()
  await expect(page.getByText('淘宝 · 发布任务', { exact: true })).toBeVisible()
  await expect(page.getByText('淘宝 · 已生效', { exact: true })).toBeVisible()
  await expect(page.getByText('暂无真实发布任务', { exact: true })).toHaveCount(0)
})

test('both sync-all entry points target every readable store including same-platform stores', async ({ page }) => {
  const syncRequests = []
  const accounts = [
    { platform: 'taobao', accountId: 'store-a', label: '淘宝 A 店', state: 'connected', readEnabled: true, writeEnabled: true },
    { platform: 'taobao', accountId: 'store-b', label: '淘宝 B 店', state: 'connected', readEnabled: true, writeEnabled: true },
    { platform: 'jd', accountId: 'store-c', label: '京东 C 店', state: 'connected', readEnabled: true, writeEnabled: true },
  ]
  await page.route('**/api/v1/platform-accounts', route => fulfillJson(route, { items: accounts }))
  await page.route(/\/api\/v1\/products(?:\?.*)?$/, route => fulfillPageJson(route, []))
  await page.route('**/api/v1/platform-accounts/*/sync', async route => {
    syncRequests.push({ url: route.request().url(), body: route.request().postDataJSON(), accountHeader: await route.request().headerValue('x-account-id') })
    await fulfillJson(route, { platform: 'taobao', source: 'official_api', simulated: false, items: [] })
  })

  await page.goto(appUrl)
  const overviewSyncButton = page.getByRole('button', { name: '同步全部店铺', exact: true })
  await expect(overviewSyncButton).toBeEnabled()
  await overviewSyncButton.click()
  await expect.poll(() => syncRequests.length).toBe(3)
  expect(syncRequests.map(item => item.body.account_id).sort()).toEqual(['store-a', 'store-b', 'store-c'])
  syncRequests.length = 0

  await page.getByRole('button', { name: '商品与资产', exact: true }).first().click()
  await expect(page.getByText(/已发现 3 家可同步店铺/)).toBeVisible()
  const syncButton = page.getByRole('button', { name: '同步全部店铺', exact: true })
  await expect(syncButton).toBeEnabled()
  await syncButton.click()
  await expect.poll(() => syncRequests.length).toBe(3)

  expect(syncRequests.map(item => item.body.account_id).sort()).toEqual(['store-a', 'store-b', 'store-c'])
  expect(syncRequests.map(item => item.accountHeader).sort()).toEqual(['store-a', 'store-b', 'store-c'])
  expect(syncRequests.filter(item => item.url.includes('/taobao/')).length).toBe(2)
})

test('store discovery failure disables sync and sends no sync request', async ({ page }) => {
  let syncRequests = 0
  await page.route('**/api/v1/platform-accounts', route => fulfillJson(route, null, 503, { code: 'STORE_DISCOVERY_FAILED', message: '店铺服务不可用' }))
  await page.route(/\/api\/v1\/products(?:\?.*)?$/, route => fulfillPageJson(route, []))
  await page.route('**/api/v1/platform-accounts/*/sync', route => { syncRequests += 1; return fulfillJson(route, {}) })

  await page.goto(appUrl)
  await expect(page.getByRole('alert').filter({ hasText: '店铺发现失败' }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: /同步全部店铺|等待店铺连接/, exact: true }).first()).toBeDisabled()
  await page.getByRole('button', { name: '商品与资产', exact: true }).first().click()
  await expect(page.getByRole('alert').filter({ hasText: '店铺发现失败' })).toBeVisible()
  await expect(page.getByRole('button', { name: /同步全部店铺|等待店铺连接/, exact: true }).first()).toBeDisabled()
  await expect.poll(() => syncRequests).toBe(0)
})
