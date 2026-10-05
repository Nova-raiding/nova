import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

async function callTask(method: string, result: any) {
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: { result }, error: null })) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test HTTP server unavailable')
  const child = spawn(process.execPath, [fileURLToPath(new URL('./bridge.mjs', import.meta.url))], {
    env: { ...process.env, NODE_ENV: 'test', DEPLOY_ENV: '${DEPLOY_ENV}', MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`,
      MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_TOKEN_SOURCE: 'environment', MERCHANT_MCP_TOKEN: 'test-fixture-token', MERCHANT_MCP_REFRESH_TOKEN: '', MERCHANT_ALLOW_FIXTURE_FALLBACK: 'true' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: child.stdout }); const iterator = lines[Symbol.asyncIterator]()
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name: 'workspace.interactive.confirm', arguments: { confirmation: 'I_CONFIRM_INTERACTIVE_WRITES' } } }) + '\n')
    await iterator.next()
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: method, arguments: {
      ...(method === 'catalog.import' ? { platform: 'taobao', title: 'QA', draft_only: 'true' } : method === 'knowledge.asset.update' ? { asset_id: 'knowledge_qa', approval_status: 'approved' } : method === 'task.create.draft' ? { product_id: 'prod_qa', platform: 'taobao' } : { product_id: 'prod_qa' }),
    } } }) + '\n')
    const line = await iterator.next(); return JSON.parse(line.value!).result
  } finally { lines.close(); child.kill(); server.close(); await once(server, 'close') }
}

const captured = {"id": "prod_taobao_local_9170315b68040470aa98", "workspaceId": "ws_guirenniaoniao", "platform": "taobao", "storeName": "导入店铺", "localProductKey": "qa-20261005-blue-observed-facts-v1", "title": "QA蓝色袋状示意图事实资料（非真实商品）", "skuCount": 0, "stock": 0, "sourceAssetIds": ["asset_2cdcfe03-a5bb-4bbb-b9db-5c3445a598c7"], "attributes": {"qa_scope": "内部技术QA原创示意图，不是真实商品，不用于商业发布", "visual_observation": "白色背景上有蓝色圆角袋状图形；靠上有一条浅色水平线和灰色方形拉链头示意", "visible_text_top": "QA TEST FIXTURE - NOT A REAL PRODUCT", "visible_text_bottom": "BLUE / ZIPPER / STORAGE BAG", "evidence_source": "owner agent 对原始QA PNG的目视核验；文本与已有OCR结果互相核对，未再次调用OCR", "source_asset_id": "asset_2cdcfe03-a5bb-4bbb-b9db-5c3445a598c7", "source_sha256": "8f6cfef814e439c63f59455348a849283356b1bdc3a4e09767636e41f19262a2", "unknown_facts": "未提供真实材质、尺寸、品牌、价格、库存、SKU或功效，不能从示意图推断"}, "factsConfirmed": false, "source": "csv", "updatedAt": "2026-10-05T04:09:36.694Z", "version": 1, "ruleScan": {"scannedAt": "2026-10-05T04:09:36.694Z", "evidenceBoundary": "仅完成本地确定性规则扫描；不代表外部平台最终审核通过", "status": "unavailable", "ruleVersionIds": ["cn-commerce-1.0.0", "taobao-apparel-1.0.0"], "findings": [{"code": "PLATFORM_RULE_DATA_UNAVAILABLE", "severity": "error", "field": "platform", "message": "签名规则清单地址或验签密钥未完整配置，系统不会自动导入平台规则"}]}, "product_id": "prod_taobao_local_9170315b68040470aa98", "rule_scan": {"scannedAt": "2026-10-05T04:09:36.694Z", "evidenceBoundary": "仅完成本地确定性规则扫描；不代表外部平台最终审核通过", "status": "unavailable", "ruleVersionIds": ["cn-commerce-1.0.0", "taobao-apparel-1.0.0"], "findings": [{"code": "PLATFORM_RULE_DATA_UNAVAILABLE", "severity": "error", "field": "platform", "message": "签名规则清单地址或验签密钥未完整配置，系统不会自动导入平台规则"}]}, "draft_only": true, "candidate_status": "未绑定商品、仅草稿、不可发布", "publishable": false, "knowledge": {"assetCount": 1, "documentCount": 1, "chunkCount": 1, "bindingCount": 1, "approvalStatus": "pending", "rightsStatus": "unknown", "indexState": "queued"}}
describe('captured draft catalog import text', () => {
  it.each(['captured', 'approved', 'rejected', 'false_ok', 'failed_status', 'missing_id', 'publishable', 'missing_knowledge', 'unknown_index'])('preserves factual status: %s', async variant => {
    const result: any = structuredClone(captured)
    if (variant === 'approved') { result.factsConfirmed = true; result.knowledge.approvalStatus = 'approved'; result.knowledge.rightsStatus = 'cleared'; result.knowledge.indexState = 'ready' }
    if (variant === 'rejected') { result.knowledge.approvalStatus = 'rejected'; result.knowledge.rightsStatus = 'restricted'; result.knowledge.indexState = 'failed' }
    if (variant === 'false_ok') result.ok = false
    if (variant === 'failed_status') result.status = 'failed'
    if (variant === 'missing_id') delete result.product_id
    if (variant === 'publishable') result.publishable = true
    if (variant === 'missing_knowledge') delete result.knowledge
    if (variant === 'unknown_index') result.knowledge.indexState = 'unknown'
    const response = await callTask('catalog.import', result)
    const text = response.content[0].text
    if (['captured', 'approved', 'rejected'].includes(variant)) {
      expect(text).toContain('已导入为未绑定草稿，不可发布')
      expect(text).toContain('平台规则暂不可用')
      expect(text).toContain('系统默认库存或SKU数量不代表用户提供的事实')
      expect(text).toContain('本次导入没有生成内容')
      if (variant === 'captured') { expect(text).toContain('商品事实待确认'); expect(text).toContain('知识资料待审核，权益待确认，索引排队中') }
      if (variant === 'approved') expect(text).toContain('知识资料已审核，权益已确认，索引已就绪')
      if (variant === 'rejected') expect(text).toContain('知识资料已拒绝，权益受限，索引失败')
    } else { expect(text).toContain('导入结果尚未确认'); expect(text).not.toContain('已导入') }
  })
})

const confirmedCapture = {"id": "prod_taobao_local_9170315b68040470aa98", "stock": 0, "title": "QA蓝色袋状示意图事实资料（非真实商品）", "source": "csv", "version": 2, "platform": "taobao", "ruleScan": {"status": "unavailable", "findings": [{"code": "PLATFORM_RULE_DATA_UNAVAILABLE", "field": "platform", "message": "签名规则清单地址或验签密钥未完整配置，系统不会自动导入平台规则", "severity": "error"}], "scannedAt": "2026-10-05T04:09:36.694Z", "ruleVersionIds": ["cn-commerce-1.0.0", "taobao-apparel-1.0.0"], "evidenceBoundary": "仅完成本地确定性规则扫描；不代表外部平台最终审核通过"}, "skuCount": 0, "storeName": "导入店铺", "updatedAt": "2026-10-05T04:10:30.600Z", "attributes": {"qa_scope": "内部技术QA原创示意图，不是真实商品，不用于商业发布", "source_sha256": "8f6cfef814e439c63f59455348a849283356b1bdc3a4e09767636e41f19262a2", "unknown_facts": "未提供真实材质、尺寸、品牌、价格、库存、SKU或功效，不能从示意图推断", "evidence_source": "owner agent 对原始QA PNG的目视核验；文本与已有OCR结果互相核对，未再次调用OCR", "source_asset_id": "asset_2cdcfe03-a5bb-4bbb-b9db-5c3445a598c7", "visible_text_top": "QA TEST FIXTURE - NOT A REAL PRODUCT", "visual_observation": "白色背景上有蓝色圆角袋状图形；靠上有一条浅色水平线和灰色方形拉链头示意", "visible_text_bottom": "BLUE / ZIPPER / STORAGE BAG"}, "workspaceId": "ws_guirenniaoniao", "factsConfirmed": true, "sourceAssetIds": ["asset_2cdcfe03-a5bb-4bbb-b9db-5c3445a598c7"], "localProductKey": "qa-20261005-blue-observed-facts-v1", "product_id": "prod_taobao_local_9170315b68040470aa98", "factsConfirmationRequired": false, "humanConfirmed": true, "facts_confirmation": {"state": "confirmed", "required": false, "product_id": "prod_taobao_local_9170315b68040470aa98", "next_action": null}, "resumed_task_ids": []}
describe('captured catalog facts confirmation text', () => {
  it.each(['captured', 'false_facts', 'required', 'wrong_product', 'false_ok', 'failed'])('does not overstate confirmation: %s', async variant => {
    const result: any = structuredClone(confirmedCapture)
    if (variant === 'false_facts') result.factsConfirmed = false
    if (variant === 'required') result.facts_confirmation.required = true
    if (variant === 'wrong_product') result.facts_confirmation.product_id = 'other'
    if (variant === 'false_ok') result.ok = false
    if (variant === 'failed') result.status = 'failed'
    const response = await callTask('catalog.facts.confirm', result)
    const text = response.content[0].text
    if (variant === 'captured') { expect(text).toContain('商品资料事实已确认'); expect(text).toContain('平台规则暂不可用'); expect(text).toContain('不代表内容已生成或可发布'); expect(text).not.toContain('真人') }
    else { expect(text).toContain('确认结果尚未确认'); expect(text).not.toContain('事实已确认') }
  })
})

const knowledgeCapture = {"id": "knowledge_asset_product_prod_taobao_local_9170315b68040470aa98", "workspaceId": "ws_guirenniaoniao", "kind": "product_facts", "name": "QA蓝色袋状示意图事实资料（非真实商品） 商品事实", "content": {"id": "prod_taobao_local_9170315b68040470aa98", "title": "QA蓝色袋状示意图事实资料（非真实商品）", "platform": "taobao", "attributes": {"qa_scope": "内部技术QA原创示意图，不是真实商品，不用于商业发布", "source_sha256": "8f6cfef814e439c63f59455348a849283356b1bdc3a4e09767636e41f19262a2", "unknown_facts": "未提供真实材质、尺寸、品牌、价格、库存、SKU或功效，不能从示意图推断", "evidence_source": "owner agent 对原始QA PNG的目视核验；文本与已有OCR结果互相核对，未再次调用OCR", "source_asset_id": "asset_2cdcfe03-a5bb-4bbb-b9db-5c3445a598c7", "visible_text_top": "QA TEST FIXTURE - NOT A REAL PRODUCT", "visual_observation": "白色背景上有蓝色圆角袋状图形；靠上有一条浅色水平线和灰色方形拉链头示意", "visible_text_bottom": "BLUE / ZIPPER / STORAGE BAG"}, "workspaceId": "ws_guirenniaoniao"}, "sourceAssetId": "asset_2cdcfe03-a5bb-4bbb-b9db-5c3445a598c7", "productId": "prod_taobao_local_9170315b68040470aa98", "sourceVersion": 1, "approvalStatus": "approved", "rightsStatus": "cleared", "indexState": "queued", "revision": 2, "createdAt": "2026-10-05T04:09:36.716Z", "updatedAt": "2026-10-05T04:10:50.585Z"}
describe('captured knowledge review text', () => {
  it.each(['captured', 'pending', 'rejected', 'false_ok', 'unknown_index', 'missing_revision'])('keeps review separate from readiness: %s', async variant => {
    const result: any = structuredClone(knowledgeCapture)
    if (variant === 'pending') { result.approvalStatus = 'pending'; result.rightsStatus = 'unknown' }
    if (variant === 'rejected') { result.approvalStatus = 'rejected'; result.rightsStatus = 'restricted'; result.indexState = 'failed' }
    if (variant === 'false_ok') result.ok = false
    if (variant === 'unknown_index') result.indexState = 'unknown'
    if (variant === 'missing_revision') delete result.revision
    const response = await callTask('knowledge.asset.update', result)
    const text = response.content[0].text
    if (['captured', 'pending', 'rejected'].includes(variant)) {
      expect(text).toContain('知识资料记录已更新')
      expect(text).toContain('不代表素材扫描通过或生成准入已通过')
      if (variant === 'captured') expect(text).toContain('审核通过，权益已确认，索引排队中')
      if (variant === 'pending') expect(text).toContain('待审核，权益待确认')
      if (variant === 'rejected') expect(text).toContain('已拒绝，权益受限，索引失败')
    } else { expect(text).toContain('更新结果尚未确认'); expect(text).not.toContain('记录已更新') }
  })
})

const taskCapture = {"id": "task_faa3ecf6-2ac1-4162-be75-e44e9d651819", "workspaceId": "ws_guirenniaoniao", "productId": "prod_taobao_local_9170315b68040470aa98", "platform": "taobao", "candidateOnly": true, "requestText": "内部技术QA：基于已审核资料制作纯文本候选；图片可见事实来自已核验OCR和明确的人工观察资料，不声称文本模型看到了图片。仅描述蓝色袋状示意图及测试标识，不是真实商品，不推断材质尺寸品牌价格库存SKU功效，不修改库存，不发布。", "inputSnapshotId": "task:task_faa3ecf6-2ac1-4162-be75-e44e9d651819:v1", "answers": {"placement": "纯文本"}, "missingQuestions": [{"id": "goal", "kind": "recommended", "prompt": "这次内容最重要的业务目标是什么？", "why": "目标会影响卖点排序和创意方向。", "ifSkipped": "默认以准确表达商品事实并支持上架审核为目标。"}, {"id": "audience", "kind": "recommended", "prompt": "主要面向哪类消费者或使用场景？", "why": "明确受众能让表达更贴合实际购买场景。", "ifSkipped": "使用通用消费者表达，不推断具体人群。"}, {"id": "stock_status", "kind": "recommended", "prompt": "当前商品库存为 0，是否先补库存再继续？", "why": "库存与可售状态会影响发布字段映射和业务判断。", "ifSkipped": "先生成草稿并先补充库存后再继续。"}, {"id": "output_count", "kind": "optional", "prompt": "需要几套候选内容？", "why": "数量会影响制作时间和成本。", "ifSkipped": "默认生成 1 套。"}], "deferredQuestionIds": [], "deferredQuestions": [], "state": "ready_for_direction", "version": 1, "createdAt": "2026-10-05T04:11:22.580Z", "task_id": "task_faa3ecf6-2ac1-4162-be75-e44e9d651819", "product_id": "prod_taobao_local_9170315b68040470aa98", "candidate_only": true, "storeContext": null}
describe('captured candidate task creation text', () => {
  it.each(['captured', 'draft', 'false_ok', 'bound', 'wrong_product', 'unknown_state', 'missing_questions'])('preserves task scope and pending questions: %s', async variant => {
    const result: any = structuredClone(taskCapture)
    if (variant === 'draft') result.state = 'draft'
    if (variant === 'false_ok') result.ok = false
    if (variant === 'bound') result.storeContext = { accountId: 'bound' }
    if (variant === 'wrong_product') result.product_id = 'other'
    if (variant === 'unknown_state') result.state = 'unknown'
    if (variant === 'missing_questions') delete result.missingQuestions
    const response = await callTask('task.create.draft', result)
    const text = response.content[0].text
    if (['captured', 'draft'].includes(variant)) {
      expect(text).toContain('候选草稿任务已创建，不可发布')
      expect(text).toContain('仍有 4 项待核对问题')
      expect(text).toContain('本次创建没有生成内容')
      expect(text).toContain('不代表商品库存等事实已核实')
      if (variant === 'draft') expect(text).toContain('先补充必要输入')
    } else { expect(text).toContain('创建结果尚未确认'); expect(text).not.toContain('任务已创建') }
  })
})
