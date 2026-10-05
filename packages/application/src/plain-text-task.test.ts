import { describe, expect, it } from 'vitest'
import { MerchantService } from './service.js'
import type { ContentGenerationInput } from '../../ai/src/generator.js'

const request = '不要详情页，只要纯文本。用于内部审核。不用于商业发布。禁止添加材质、尺寸、价格和功效。'
const body = { title: '内部审核', detail: '蓝色袋子，带拉链和 QA 标识。内部待审核，不用于商业发布。', sellingPoints: [] }
function prepared(generator?: { generate(input: ContentGenerationInput): Promise<typeof body> }) {
  const service = new MerchantService({ fixtureMode: true, seedFixture: false, ...(generator ? { contentGenerator: generator } : {}) })
  const product = service.importProduct({ workspaceId: 'ws_plain', platform: 'taobao', remoteId: 'plain-test', title: '蓝色袋子', stock: 0, skuCount: 0 })
  service.confirmProductFacts('ws_plain', product.id)
  const task = service.createTask({ workspaceId: 'ws_plain', productId: product.id, platform: 'taobao', requestText: request, candidateOnly: true })
  service.selectDirection(task.id, 'A')
  service.confirmProductionPlan('ws_plain', task.id, 'merchant', task.version)
  return { service, task, product }
}
describe('plain text task contract', () => {
  it('preserves negative purpose and chooses the positive requested output', () => {
    const service = new MerchantService({ fixtureMode: true, seedFixture: false })
    const fields = service.understandTaskRequest('ws_plain', request).extracted
    expect(fields).toMatchObject({ placement: '纯文本', scene: '内部审核' })
    expect(fields.constraints).toContain('不用于商业发布')
    expect(service.understandTaskRequest('ws_plain', '只要纯文本不要详情页').extracted.placement).toBe('纯文本')
    expect(service.understandTaskRequest('ws_plain', '只要纯文案').extracted.placement).toBe('纯文本')
    expect(service.understandTaskRequest('ws_plain', '不要纯文本，制作详情页').extracted.placement).toBe('商品详情页')
    expect(service.understandTaskRequest('ws_plain', '不用于商业发布。').extracted.scene).toBeUndefined()
    expect(service.understandTaskRequest('ws_plain', '制作详情页。用于商业发布。').extracted).toMatchObject({ placement: '商品详情页', scene: '商业发布' })
  })
  it('freezes actual instructions through generator and persists a genuinely plain body', async () => {
    let input: ContentGenerationInput | undefined
    const { service, task } = prepared({ generate: async value => { input = value; return body } })
    expect(task.productionPlan).toMatchObject({ outputType: 'plain_text', outputFormat: 'Markdown + JSON', sellingPoints: [], sellingPointEvidence: [] })
    task.answers.constraints = 'later mutation'
    task.requestText = 'later request mutation'
    const version = await service.generateDraft(task.id)
    expect(input).toMatchObject({ outputType: 'plain_text', candidateOnly: true, taskIntent: { requestText: request, constraints: expect.stringContaining('不用于商业发布'), sourceAssets: [] } })
    expect(input?.product).toEqual({ id: task.productId, title: '蓝色袋子' })
    expect(input?.confirmedFactSourceIds).toBeUndefined()
    expect(version.body).toEqual(body)
    expect(service.reviewContent('ws_plain', version.id).filter(f => f.severity === 'error')).toEqual([])
    const json = JSON.parse(service.exportContent('ws_plain', version.id, 'json').body)
    expect(json.body).toEqual(body)
    expect(json.brief).toBeUndefined()
    const markdown = service.exportContent('ws_plain', version.id, 'markdown').body
    expect(markdown).toContain(body.detail)
    expect(markdown).not.toMatch(/静态素材|CTA|内容模块|## 卖点/u)
    const manifest = JSON.parse(service.exportContent('ws_plain', version.id, 'manifest').body)
    expect(JSON.stringify(manifest)).not.toContain('brief.json')
    expect(() => service.regenerateContentModule({ workspaceId: 'ws_plain', sourceVersionId: version.id, moduleKey: 'selling_points', reason: 'test' })).toThrowError(expect.objectContaining({ code: 'CONTENT_MODULE_NOT_FOUND' }))
    const changed = service.modifyContentVersion({ workspaceId: 'ws_plain', sourceVersionId: version.id, changes: { detail: '内部审核说明' }, reason: 'test' }).version
    expect(changed.body.modules).toBeUndefined()
    expect(changed.body.brief).toBeUndefined()
    expect(() => service.preparePublish(task.id)).toThrowError(expect.objectContaining({ code: 'CANDIDATE_TASK_NOT_PUBLISHABLE' }))
    expect(service.exportContent('ws_plain', version.id, 'bundle').deliveryVerification?.valid).toBe(true)
  })
  it('uses frozen schema in async completion and rejects injected visual output', () => {
    const { service, task } = prepared()
    const hostInput = service.prepareCodexDraft(task.id)
    expect(hostInput.product).toEqual({ id: task.productId, title: '蓝色袋子' })
    expect(hostInput).not.toHaveProperty('confirmedFactVersionId')
    expect(hostInput.output.optional).toEqual([])
    const job = service.enqueueGeneration({ workspaceId: 'ws_plain', taskId: task.id, idempotencyKey: 'plain' })
    expect(() => service.completeGeneration({ workspaceId: 'ws_plain', jobId: job.id, body: { ...body, modules: [] } })).toThrowError(expect.objectContaining({ code: 'CONTENT_SCHEMA_INVALID' }))
    const completed = service.completeGeneration({ workspaceId: 'ws_plain', jobId: job.id, body })
    expect(completed.version.body).toEqual(body)
    expect(service.generationOutputType(task.id)).toBe('plain_text')
  })
  it('keeps unsupported plain publishing closed even outside candidate tasks', async () => {
    const { service, task } = prepared({ generate: async () => body })
    task.candidateOnly = false // exercise a formal task with the same approved plain contract
    const version = await service.generateDraft(task.id)
    service.approveContent(task.id, version.id)
    expect(() => service.preparePublish(task.id)).toThrowError(expect.objectContaining({ code: 'CONTENT_OUTPUT_NOT_PUBLISHABLE' }))
  })
  it('does not reinterpret a historical detail version after the task plan changes', () => {
    const service = new MerchantService({ fixtureMode: true })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    const version = service.createDraft(task.id)
    task.productionPlan!.outputType = 'plain_text'
    expect(version.body.modules?.length).toBeGreaterThan(0)
    expect(JSON.parse(service.exportContent('ws_demo', version.id, 'json').body).brief).toBeDefined()
  })

  it('retains review and export blockers for unsafe plain text', async () => {
    const { service, task } = prepared({ generate: async () => ({ ...body, detail: '最强商品' }) })
    const version = await service.generateDraft(task.id)
    expect(service.reviewContent('ws_plain', version.id).some(f => f.severity === 'error')).toBe(true)
    expect(() => service.approveContent(task.id, version.id)).toThrowError(expect.objectContaining({ code: 'REVIEW_BLOCKED' }))
    expect(() => service.exportContent('ws_plain', version.id, 'json')).toThrowError(expect.objectContaining({ code: 'CONTENT_EXPORT_BLOCKED' }))
  })

  it('reselects an unconfirmed plan explicitly and invalidates stale plans after answers', () => {
    const service = new MerchantService({ fixtureMode: true })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao', requestText: '只要纯文本' })
    service.selectDirection(task.id, 'A')
    task.productionPlan!.outputType = 'detail_page_and_static_brief' // persisted pre-fix unconfirmed plan
    expect(() => service.selectDirection(task.id, 'A', task.version - 1)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }))
    service.selectDirection(task.id, 'A', task.version)
    expect(task.productionPlan?.outputType).toBe('plain_text')
    service.answerTask('ws_demo', task.id, { constraints: '不用于商业发布' }, task.version)
    expect(task.state).toBe('ready_for_direction')
    expect(task.productionPlan).toBeUndefined()
    expect(() => service.confirmProductionPlan('ws_demo', task.id, 'merchant', task.version)).toThrow()
    service.selectDirection(task.id, 'A', task.version)
    expect(task.productionPlan?.constraints).toBe('不用于商业发布')
    service.confirmProductionPlan('ws_demo', task.id, 'merchant', task.version)
    expect(() => service.selectDirection(task.id, 'A', task.version)).toThrowError(expect.objectContaining({ code: 'INVALID_TASK_TRANSITION' }))
    expect(() => service.answerTask('ws_demo', task.id, { constraints: 'replace' }, task.version)).toThrowError(expect.objectContaining({ code: 'TASK_INPUT_LOCKED' }))
  })

})
