import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('../demo/merchant-studio/src/App.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('../demo/merchant-studio/src/api.ts', import.meta.url), 'utf8')
const campaign = readFileSync(new URL('../demo/merchant-studio/src/CampaignLifecyclePanel.tsx', import.meta.url), 'utf8')
const smoke = readFileSync(new URL('./merchant-studio-smoke.ts', import.meta.url), 'utf8')
const merchantNginx = readFileSync(new URL('../infra/nginx/merchant-studio.conf', import.meta.url), 'utf8')
const merchantEntrypoint = readFileSync(new URL('../infra/nginx/merchant-studio-entrypoint.sh', import.meta.url), 'utf8')
const retirementRecord = readFileSync(new URL('../dogfood/chatgpt-all-functions/retired-merchant-ui-contract-assertions.md', import.meta.url), 'utf8')

/**
 * `FactsEditor` and `AssetLibrary` are retained but have no mount point.
 *
 * The reviewed merchant interface (`2e055921`, `fdd6deac`, `c2eafb72`) gave the
 * merchant `MaterialLibraryWorkspace` instead, and `AssetLibrary` — together with
 * the `FactsEditor` that only it renders — lost its mount point. Seven assertions
 * in this file kept reading source strings out of that dead component and stayed
 * green while no route rendered them, two of them guarding safety surfaces
 * (`asset-untrusted-boundary`; the generation-blocking 视觉强规则 editor).
 *
 * They are registered as retired in
 * `dogfood/chatgpt-all-functions/retired-merchant-ui-contract-assertions.md`
 * rather than re-pointed, because the reviewed interface has no carrier for most
 * of what they promised. The block at the bottom holds the two invariants that
 * registration depends on: every retired form is still reachable *only* through
 * the retained component, so nobody can silently re-pin an assertion to it, and
 * the record names every retirement this file enforces.
 */
const factsEditorStart = app.indexOf('function FactsEditor(')
const brandMarkStart = app.indexOf('function BrandMark(')
const assetLibraryStart = app.indexOf('function AssetLibrary(')
const relationDialogStart = app.indexOf('function ProductAssetRelationDialog(')
const retainedFactsEditor = app.slice(factsEditorStart, brandMarkStart)
const retainedAssetLibrary = app.slice(assetLibraryStart, relationDialogStart)
/** `App.tsx` without the two retained regions: everything a route can actually reach. */
const liveApp = [app.slice(0, factsEditorStart), app.slice(brandMarkStart, assetLibraryStart), app.slice(relationDialogStart)].join('\n')

describe('Merchant Studio production UI contract', () => {
  it('keeps the four platform routes independent', () => {
    expect(app).toContain("platformId: 'jd'")
    expect(app).toContain("platformId: 'taobao'")
    expect(app).toContain("platformId: 'tmall'")
    expect(app).toContain("platformId: 'pinduoduo'")
    expect(app).toContain("tmall: '天猫'")
  })

  it('passes workspace, bearer and account context through the API client', () => {
    expect(api).toContain("VITE_WORKSPACE_ID")
    expect(api).toContain("VITE_API_TOKEN")
    expect(api).toContain("'x-account-id'")
    expect(api).toContain('account_id?: string')
    expect(api).toContain("runtimeEnv.MODE === 'test' ? 'ws_demo' : ''")
    expect(api).toContain("API_WORKSPACE_ID_MISSING")
  })

  it('preserves session-scoped requests instead of forcing all merchants into the deployment workspace', () => {
    expect(merchantNginx.match(/proxy_set_header X-Workspace-Id \$http_x_workspace_id;/gu)).toHaveLength(3)
    expect(merchantNginx).not.toContain('proxy_set_header X-Workspace-Id "${MERCHANT_WORKSPACE_ID}"')
    expect(merchantNginx).not.toContain('proxy_set_header X-Workspace-Id "ws_demo"')
    expect(merchantEntrypoint).toContain('MERCHANT_WORKSPACE_ID must be injected')
  })

  it('does not cache the SPA shell across merchant UI rollouts', () => {
    expect(merchantNginx).toContain('location = / {')
    expect(merchantNginx).toContain('location = /index.html {')
    expect(merchantNginx).toContain('try_files $uri $uri/ @merchant_spa')
    expect(merchantNginx).toContain('location @merchant_spa {')
    expect(merchantNginx.match(/add_header Cache-Control "no-store" always;/gu)).toHaveLength(3)
  })

  it('keeps write refusals server-driven instead of guessing a role in the browser', () => {
    // This used to assert a client-side read-only projection built from a
    // build-time `VITE_MERCHANT_ROLE` that no build path set, so it disabled
    // nothing in any delivered image while still reading like a guard. No
    // reachable session can supply the role either (see the comment in App.tsx),
    // so the promise was removed rather than re-sourced. These assertions keep
    // it removed and keep the surface that actually refuses writes.
    for (const gone of ['import.meta.env.VITE_MERCHANT_ROLE', 'merchantReadOnly', 'projectMerchantWriteControls', 'data-merchant-permission', 'data-merchant-role', 'merchant-read-only-banner']) {
      expect(app, `${gone} was removed; do not reintroduce an unfed client-side permission gate`).not.toContain(gone)
    }
    expect(api).toContain("'merchant-capability-denied'")
    expect(app).toContain("window.addEventListener('merchant-capability-denied', onDenied)")
    expect(app).toContain('当前账号没有此操作权限')
  })

  it('bounds API outage waits and presents a distinct timeout error', () => {
    expect(api).toContain('API_REQUEST_TIMEOUT_MS = 10_000')
    expect(api).toContain('new AbortController()')
    expect(api).toContain('API_REQUEST_TIMEOUT')
    expect(api).toContain('API 请求超时')
  })

  it('requires server preview and approved task context before publish confirmation', () => {
    expect(app).toContain('if (!taskContext?.task || !taskContext.version)')
    expect(app).toContain('preparePublish(apiBaseUrl, taskContext.task.id)')
    expect(app).toContain('fetchPublishJobs(baseUrl)')
    expect(app).toContain('disabled={!confirmed || loading || !preview || Boolean(identityError)}')
    expect(app).toContain("window.localStorage.setItem('merchant-studio:last-publish-task', taskContext.task.id)")
    expect(app).toContain("if (page === 'publish' && taskContext?.task)")
    expect(app).toContain("fetchProduct(apiBaseUrl, task.productId)")
    expect(app).toContain("task.state !== 'approved'")
    expect(app).toContain("const version = versions.find(item => item.state === 'approved')")
    expect(app).not.toContain("?? versions[0]")
  })

  it('restores existing tasks without creating duplicates or auto-generating content', () => {
    expect(app).toContain('? await fetchTask(baseUrl, target.taskId)')
    expect(app).toContain('const current = target.taskId ? (target.resolvedTask ?? await fetchTask(baseUrl, target.taskId)) : null')
    expect(app).toContain('createTaskFromIntent')
    expect(app).toContain('createTaskOnce(baseUrl, resolvedTarget, requestText)')
    expect(app).toContain('idempotency_key: intentKey')
    expect(app).toContain('taskCreationRequests.get(lockKey)')
    expect(app).toContain('taskId: item.id')
    expect(app).toContain('只有从商品页点击“创建任务”才会新建任务')
    expect(app).toContain('确认制作方案并生成')
    expect(app).not.toContain("created.selectedDirectionId ? Promise.resolve(created) : selectDirection(baseUrl, created.id, 'A')")
  })

  it('keeps intent confirmation and candidate selection actionable before task creation', () => {
    expect(app).toContain('data-testid="task-create-confirmation"')
    expect(app).toContain('确认需求并创建任务')
    expect(app).toContain('selectedCandidateId === candidate.id')
    expect(app).toContain('aria-pressed={selectedCandidateId === candidate.id}')
    expect(app).toContain('使用同一幂等请求重试')
  })

  it('keeps advanced batch controls secondary to the conversational task queue', () => {
    expect(campaign).toContain('const [showControls, setShowControls] = useState(false)')
    expect(campaign).toContain('打开高级控制')
    expect(campaign).toContain('暂停、恢复或重试失败项属于高级操作')
  })

  it('translates task history event codes before rendering the merchant timeline', () => {
    expect(app).toContain('const timelineEventLabel')
    expect(app).toContain('任务已创建')
    expect(app).toContain('event_type: timelineEventLabel(event.event_type)')
  })

  it('maps every locally supported upload format to the content type the live upload path sends', () => {
    // Re-anchored, not relaxed. `assetMimeType` is what `uploadAsset` puts in the
    // `content-type` header, and the reviewed 素材库 确认上传
    // (`MaterialLibraryWorkspace`) calls `uploadAsset` directly, so these three
    // entries are exercised by a reachable path.
    //
    // The `accept=".jpg,…,​.eps"` attribute this test used to assert alongside them
    // belongs to the unmounted `AssetLibrary` knowledge library and is retired with
    // the rest of it. The reviewed UI's document intake is 品牌资产 › 品牌资产文档,
    // not the material library — the material upload only offers `image/*,video/*`.
    expect(api).toContain("'.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'")
    expect(api).toContain("'.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'")
    expect(api).toContain("'.svg': 'image/svg+xml'")
  })

  it('keeps the HTTP smoke runner on the API MCP contract', () => {
    expect(smoke).toContain('method, params: { workspace_id: workspaceId, ...params }')
    expect(smoke).not.toContain("method: 'tools/call'")
  })

  it('does not present offline catalog fixtures as official platform data', () => {
    expect(app).toContain("source: '演示数据'")
    expect(app).toContain("platform: '小红书'")
    expect(app).toContain("platform: '抖音'")
    expect(app).not.toContain("source: 'CSV 降级'")
  })

  it('labels offline overview activity and connections as demonstrations', () => {
    expect(app).toContain("status: '演示连接'")
    expect(app).toContain("['演示发布状态'")
    expect(app).not.toContain("['发布已生效'")
  })

  it('makes the global product search actionable and honest about its scope', () => {
    expect(app).toContain('placeholder="搜索商品或平台"')
    expect(app).toContain('onSearchQuery={setGlobalSearch}')
    expect(app).toContain('onSearch={searchProducts}')
    expect(app).toContain("navigateTo('products', { searchQuery: query, clearContext: true })")
    expect(app).not.toContain('搜索商品、任务或版本')
  })

  it('keeps the merchant catalog pagination contract at twenty rows per page', () => {
    expect(app).toContain('const productPageSize = 20')
    expect(app).toContain('limit: productPageSize')
    expect(app).toContain('offset: productPage * productPageSize')
    expect(app).toContain('清除筛选')
  })

  it('creates a server-owned recharge order and supports status queries', () => {
    expect(app).toContain('充值订单')
    expect(app).toContain('createRechargeOrder(baseUrl')
    expect(app).toContain('支付完成后由服务端回调或查单入账')
    expect(app).toContain('查询订单')
    expect(app).toContain('fetchRechargeOrder(baseUrl, rechargeOrder.id)')
    expect(api).toContain("'billing.recharge.create'")
    expect(api).toContain("'billing.recharge.get'")
  })

  it('renders independent multi-platform child-task bindings instead of one implicit product', () => {
    expect(app).toContain('task-execution-plan')
    expect(app).toContain('不会复用其他平台商品')
    expect(app).toContain('返回商品列表分别选择')
  })

  it('preserves exact product/platform/store targets and confirms task-group creation', () => {
    expect(app).toContain('batchTargetKey(item) === batchTargetKey(target)')
    expect(app).toContain('task-group-confirm-dialog')
    expect(app).toContain('每个“商品 + 平台 + 店铺”目标会创建独立子任务')
    expect(app).not.toContain('window.confirm(')
    expect(app).toContain('同一品可选择多个平台和多个店铺')
    expect(app).toContain('task-group-created')
  })

  it('renders product previews from saved facts instead of fixed demo claims', () => {
    expect(app).toContain('product.price.toLocaleString()')
    expect(app).toContain('Object.entries(product?.attributes ?? {})')
    expect(app).toContain('标记为“待确认”的材质、性能和功效不得写成确定性卖点')
    expect(app).not.toContain('锦纶 88%')
    expect(app).not.toContain('UPF50+ 检测报告')
    expect(app).not.toContain('<strong>169</strong>')
  })

  it('renders progressive question controls and complete detail modules as merchant-facing output', () => {
    expect(app).toContain('确认商品事实准确')
    expect(app).toContain('回答并继续')
    expect(app).toContain('为什么问：{question.why}')
    expect(app).toContain('不回答：{question.ifSkipped}')
    expect(app).toContain('完整详情模块')
    expect(app).toContain('个可审阅模块')
  })

  it('renders brand-review evidence with merchant-facing labels instead of raw fields', () => {
    expect(app).toContain('任务确认时冻结的品牌档案')
    expect(app).toContain("if (field === 'content') return '文案内容'")
    expect(api).toContain("kind: 'fact' | 'rule' | 'brand' | 'content' | 'image'")
  })

  it('shows platform rejection evidence and opens the existing versioned correction flow', () => {
    expect(app).toContain('平台拒绝码：{job.rejection?.rawCode')
    expect(app).toContain('定位并修正')
    expect(app).toContain('fetchTask(apiBaseUrl, job.taskId)')
    expect(app).toContain('系统不会自动重发')
    expect(app).toContain('modifyContentVersion(baseUrl, content.id')
    expect(api).toContain('rawCode: string')
  })

  it('shows the normalized brand-unit identity that batch production will use', () => {
    expect(api).toContain('brandUnitId?: string')
    expect(api).toContain('brandUnit?: { id: string')
    expect(app).toContain('批量生产品牌单元：{brand.brandUnitId}')
  })
})

/**
 * The seven retired assertions, named by the code form each one reached for.
 *
 * `surface` is the merchant-facing promise that lost its carrier; the record has
 * the full story per row, including which server-side or agent-side contract (if
 * any) still holds the line.
 */
const RETIRED_UI_CONTRACT_FORMS: { form: string; surface: string }[] = [
  { form: 'asset-reference-count-', surface: '素材库重复上传引用计数（AssetLibrary 知识库表格）' },
  { form: '同一文件已有 {asset.references.length} 个上传引用', surface: '同上' },
  { form: 'data-testid="asset-facts-editor"', surface: '素材事实结构化确认与「查看服务端对象预览」（FactsEditor）' },
  { form: '逐项填写你从素材中核对出的事实', surface: '同上' },
  { form: '查看服务端对象预览', surface: '同上' },
  { form: 'asset-untrusted-boundary', surface: '不可信文档边界提示（安全面）' },
  { form: '不会执行其中指令、改变系统规则或自动调用工具', surface: '同上' },
  { form: 'accept=".jpg,.jpeg,.png,.webp,.gif,.svg,.pdf,.docx', surface: '知识库可选的全部文档与源格式' },
  { form: '从素材提取品牌档案', surface: '品牌档案提取的逐字段确认（与第 3 条同一类：提取结果直接写入）' },
  { form: '逐字段确认品牌档案', surface: '同上' },
  { form: '自动提取不会直接写入', surface: '同上' },
  { form: '首次建档必须确认', surface: '同上' },
  { form: 'selectedBrandFields', surface: '同上' },
  { form: '配置视觉强规则', surface: '生成阻断视觉强规则编辑器（安全面）' },
  { form: 'restricted-people', surface: '同上' },
  { form: 'restricted-spokespersons', surface: '同上' },
  { form: 'restricted-ips', surface: '同上' },
  { form: "conflict_resolutions: { visualRules: 'candidate' }", surface: '同上' },
  { form: 'knowledge-table-wrap', surface: '知识库只读分页表格' },
  { form: 'pageSizeOptions: [10, 20, 50]', surface: '同上' },
]

describe('retired merchant UI-contract assertions', () => {
  it('retains the unmounted components every retirement depends on', () => {
    // The record's premise is "kept on purpose, so the coverage can be restored by
    // re-adding a mount point". If the component is deleted instead, the record is
    // stale and the retirement reason is wrong.
    expect(app).toContain('function AssetLibrary(')
    expect(app).toContain('function FactsEditor(')
    expect(app).not.toContain('<AssetLibrary')
    // Real slices, so a moved marker fails loudly instead of asserting over "".
    expect(retainedFactsEditor.length).toBeGreaterThan(1_000)
    expect(retainedAssetLibrary.length).toBeGreaterThan(20_000)
    expect(liveApp.length).toBeGreaterThan(app.length * 0.5)
  })

  it.each(RETIRED_UI_CONTRACT_FORMS)('keeps $form out of the reachable merchant UI ($surface)', ({ form }) => {
    expect(
      app,
      `${form} is gone from App.tsx, so the retirement record's premise ("retained but unmounted") no longer holds`,
    ).toContain(form)
    expect(
      liveApp,
      `${form} left the retained component and is now on a reachable path. Re-anchoring an assertion to it is an interface decision for the owner, not a silent fix.`,
    ).not.toContain(form)
  })

  it('names every retired assertion in the written record', () => {
    const missing = RETIRED_UI_CONTRACT_FORMS.filter(({ form }) => !retirementRecord.includes(form)).map(({ form }) => form)
    expect(
      missing,
      'retired-merchant-ui-contract-assertions.md must name every retirement this file enforces, otherwise the record and the suite disagree about what coverage was lost',
    ).toEqual([])
  })
})
