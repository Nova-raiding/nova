import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('../demo/merchant-studio/src/App.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('../demo/merchant-studio/src/api.ts', import.meta.url), 'utf8')
const campaign = readFileSync(new URL('../demo/merchant-studio/src/CampaignLifecyclePanel.tsx', import.meta.url), 'utf8')
const smoke = readFileSync(new URL('./merchant-studio-smoke.ts', import.meta.url), 'utf8')

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

  it('shows durable duplicate-upload references in the asset library', () => {
    expect(app).toContain('同一文件已有 {asset.references.length} 个上传引用')
    expect(app).toContain('asset-reference-count-')
  })

  it('uses structured merchant-facing fact confirmation while preserving the server object preview', () => {
    expect(app).toContain('data-testid="asset-facts-editor"')
    expect(app).toContain('逐项填写你从素材中核对出的事实')
    expect(app).toContain('查看服务端对象预览')
    expect(app).not.toContain('已核对事实 JSON<textarea')
  })

  it('translates task history event codes before rendering the merchant timeline', () => {
    expect(app).toContain('const timelineEventLabel')
    expect(app).toContain('任务已创建')
    expect(app).toContain('event_type: timelineEventLabel(event.event_type)')
  })

  it('shows the untrusted-document boundary before merchants use uploaded material', () => {
    expect(app).toContain('asset-untrusted-boundary')
    expect(app).toContain('不会执行其中指令、改变系统规则或自动调用工具')
  })

  it('lets the knowledge library select every locally supported document and source format', () => {
    expect(app).toContain('accept=".jpg,.jpeg,.png,.webp,.gif,.svg,.pdf,.docx,.xlsx,.json,.txt,.md,.csv,.ai,.eps')
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
    expect(app).toContain("status: '演示已连接'")
    expect(app).toContain("['演示发布状态'")
    expect(app).not.toContain("['发布已生效'")
  })

  it('makes the global product search actionable and honest about its scope', () => {
    expect(app).toContain('placeholder="搜索商品"')
    expect(app).toContain("event.metaKey || event.ctrlKey")
    expect(app).toContain("if (event.key === 'Enter') onSearch()")
    expect(app).toContain('initialQuery={globalSearch}')
    expect(app).not.toContain('搜索商品、任务或版本')
  })

  it('shows a persistent mock recharge order card and supports status queries', () => {
    expect(app).toContain('充值订单')
    expect(app).toContain('不会产生真实扣款')
    expect(app).toContain('paymentMode === \'fixture\'')
    expect(app).toContain('查询订单')
    expect(app).toContain('fetchRechargeOrder(baseUrl, rechargeOrder.id)')
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
    expect(app).toContain('待补资料')
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

  it('requires explicit field confirmation before saving extracted brand facts', () => {
    expect(app).toContain('从素材提取品牌档案')
    expect(app).toContain('逐字段确认品牌档案')
    expect(app).toContain('自动提取不会直接写入')
    expect(app).toContain('selectedBrandFields')
    expect(app).toContain('首次建档必须确认“品牌名称”')
    expect(api).toContain("'/v1/brand-profile/extract'")
  })

  it('provides a merchant-facing editor for generation-blocking visual rules', () => {
    expect(app).toContain('配置视觉强规则')
    expect(app).toContain('Logo、品牌色与字体强规则')
    expect(app).toContain('默认全部禁止')
    expect(app).toContain('当前字体授权会阻止生成')
    expect(app).toContain('禁用内容、人物、代言人与 IP')
    expect(app).toContain('restricted-people')
    expect(app).toContain('restricted-spokespersons')
    expect(app).toContain('restricted-ips')
    expect(app).toContain("conflict_resolutions: { visualRules: 'candidate' }")
    expect(api).toContain('visual_rules?: BrandVisualRules')
  })

  it('lets merchants explicitly rate historical assets with reasons', () => {
    expect(app).toContain('评价素材')
    expect(app).toContain('优秀，后续作为参考')
    expect(app).toContain('不喜欢，后续排除')
    expect(app).toContain('评价历史素材必须填写至少一条具体原因')
    expect(api).toContain('/preference`')
  })
})
