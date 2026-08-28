#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

const PROTOCOL_VERSION = '2025-06-18'
const RECHARGE_UI_URI = 'ui://merchant-marketing/recharge-v1.html'
const MERCHANT_CONTEXT_UI_URI = 'ui://merchant-marketing/context-v1.html'
const MERCHANT_CONTEXT_METHODS = new Set([
  'merchant.start', 'workspace.health', 'catalog.search', 'catalog.import.batch',
  'task.group.create', 'publish.batch.prepare', 'publish.batch.get',
])
const RECHARGE_UI_METHODS = new Set([
  'billing.status', 'billing.recharge.create', 'billing.recharge.get', 'billing.recharge.list',
  'content.generate', 'catalog.image.generate', 'catalog.title.optimize',
  'multimodal.generate', 'multimodal.image.edit', 'multimodal.video.request',
])
const MAX_LOCAL_UPLOAD_BYTES = 50 * 1024 * 1024
const MAX_EXPORT_ARTIFACT_BYTES = 25 * 1024 * 1024
const MAX_REMOTE_RESPONSE_BYTES = 36 * 1024 * 1024
const MAX_SESSION_ARTIFACT_BYTES = 250 * 1024 * 1024
const MAX_SESSION_ARTIFACT_FILES = 100
const INTERACTIVE_WRITE_TTL_MS = 15 * 60 * 1000
let sessionArtifactDirectory
let sessionArtifactBytes = 0
let sessionArtifactFiles = 0
let interactiveWriteUntil = 0
let bootstrappedWorkspaceId = ''
const READ_ONLY_METHODS = new Set([
  'merchant.start',
  'merchant.first_value',
  'brand-unit.list', 'brand-unit.listing.list', 'campaign.batch.get',
  'workspace.health', 'catalog.search', 'catalog.categories', 'catalog.image.get',
  'workspace.metrics', 'workspace.commercial.get', 'workspace.usage.get', 'ops.audit.list', 'ops.audit.export', 'ops.data.delete.list', 'ops.members.list', 'ops.session', 'ops.workspaces.list', 'ops.users.list', 'ops.users.export', 'ops.user.detail', 'ops.commercial.offers.list', 'ops.commercial.addons.list', 'ops.commercial.coupons.list', 'ops.commercial.export', 'ops.commercial.rollouts.list', 'ops.growth.funnel', 'ops.alerts.list', 'subscription.get', 'subscription.orders.list', 'billing.reconciliation', 'platform.settings.get',
  'billing.status', 'billing.recharge.get', 'billing.recharge.list', 'billing.transactions', 'billing.export', 'catalog.sync.get',
  'rule.list', 'rule.sync.status', 'rule.history', 'rule.audit', 'asset.list', 'brand.get', 'brand.extract', 'brand.tone.preview',
  'deliverable.list', 'task.history', 'task.resume', 'task.timeline', 'feedback.list', 'generation.get', 'content.review',
  'content.versions', 'content.diff', 'publish.get', 'publish.batch.get',
  'knowledge.rule.list', 'knowledge.asset.list', 'knowledge.learning.list', 'knowledge.competitor.list', 'knowledge.competitor.reference', 'automation.policy.get', 'automation.policy.list', 'automation.scan',
])
const MERCHANT_HIDDEN_METHODS = new Set([
  'billing.model-usage.reconciliation.run',
  'billing.model-usage.resolve',
  'billing.usage.consume',
  'billing.usage.refund',
  'billing.refund',
  'billing.reconciliation.run',
  'platform.settings.update',
  'platform.revoke',
  'platform.model.status',
])
const isMerchantTool = name => !name.startsWith('ops.') && !MERCHANT_HIDDEN_METHODS.has(name)
// These actions are explicitly part of first-run activation or read-only
// catalog synchronization. They may create a pending order or a sync handle,
// but do not consume wallet balance or publish content. Generation, editing,
// approvals, and publish confirmation remain behind the interactive-write gate.
const SAFE_WITHOUT_INTERACTIVE_WRITE = new Set([
  ...READ_ONLY_METHODS,
  'content.export', 'catalog.image.review', 'workspace.bootstrap',
  'workspace.interactive.confirm',
  'platform.connect', 'billing.recharge.create', 'catalog.sync', 'catalog.sync.start',
])
const METHODS = {
  'merchant.start': {
    description: '开始使用大麦；返回当前步骤、店铺/商品摘要和下一句可以直接照着说的话。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'merchant.first_value': {
    description: '返回首个价值安全预览包；传 example=true 可查看静态示例，不代表真实商品，不发布内容；服务端不调用模型。',
    inputSchema: { type: 'object', properties: { platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, account_id: { type: 'string' }, product_id: { type: 'string' }, example: { type: 'string', enum: ['true'] } }, additionalProperties: false },
  },
  'brand-unit.list': {
    description: '查看当前工作区的品及其已绑定店铺。只读。',
    inputSchema: { type: 'object', properties: { brand_id: { type: 'string' }, platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, account_id: { type: 'string' } }, additionalProperties: false },
  },
  'brand-unit.create': {
    description: '创建可持久化的品，作为多平台、多店铺和跨店商品事实的归属单元。',
    inputSchema: { type: 'object', properties: { brand_id: { type: 'string' }, name: { type: 'string' } }, required: ['name'], additionalProperties: false },
  },
  'brand-unit.bind-store': {
    description: '将已存在的平台授权店铺绑定到指定品。',
    inputSchema: { type: 'object', properties: { brand_id: { type: 'string' }, platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, account_id: { type: 'string' } }, required: ['brand_id', 'platform', 'account_id'], additionalProperties: false },
  },
  'brand-unit.product.create': {
    description: '在品下创建可跨平台复用的商品事实。',
    inputSchema: { type: 'object', properties: { brand_id: { type: 'string' }, product_id: { type: 'string' }, source_product_id: { type: 'string' }, title: { type: 'string' } }, required: ['brand_id', 'title'], additionalProperties: false },
  },
  'brand-unit.listing.create': {
    description: '将商品事实映射到已绑定的平台店铺。',
    inputSchema: { type: 'object', properties: { brand_id: { type: 'string' }, canonical_product_id: { type: 'string' }, listing_id: { type: 'string' }, platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, account_id: { type: 'string' }, remote_product_id: { type: 'string' } }, required: ['brand_id', 'canonical_product_id', 'platform', 'account_id'], additionalProperties: false },
  },
  'brand-unit.listing.list': {
    description: '查看商品在多个平台和店铺上的映射。只读。',
    inputSchema: { type: 'object', properties: { brand_id: { type: 'string' }, canonical_product_id: { type: 'string' }, platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, account_id: { type: 'string' } }, additionalProperties: false },
  },
  'brand-unit.access.grant': {
    description: '向当前工作区的 active 成员授予指定品的查看、编辑、发布或管理权限。',
    inputSchema: { type: 'object', properties: { brand_id: { type: 'string' }, external_subject: { type: 'string' }, role: { type: 'string', enum: ['viewer', 'editor', 'publisher', 'admin'] }, reason: { type: 'string' } }, required: ['brand_id', 'external_subject', 'role'], additionalProperties: false },
  },
  'campaign.batch.create': {
    description: '为一个品和最多 50 个跨平台、跨店商品创建可恢复的批量运营计划；不会自动发布。',
    inputSchema: { type: 'object', properties: { brand_id: { type: 'string' }, platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, account_id: { type: 'string' }, product_ids_json: { type: 'string', description: '兼容单店铺模式：1 至 50 个商品 ID 的 JSON 数组' }, targets_json: { type: 'string', description: '多目标模式：每项含 product_id 或 canonical_product_id、platform、account_id，可选 listing_id' }, idempotency_key: { type: 'string', description: '重试同一批量计划时保持不变' } }, required: ['brand_id'], additionalProperties: false },
  },
  'campaign.batch.get': {
    description: '刷新并查看批量计划逐商品状态、汇总、阻断项和下一步；只读。',
    inputSchema: { type: 'object', properties: { campaign_id: { type: 'string' } }, required: ['campaign_id'], additionalProperties: false },
  },
  'campaign.batch.generate': {
    description: '启动可恢复的逐商品内容工作流；事实确认后自动续跑到待审核，每项仍需规则审核和人工批准。',
    inputSchema: { type: 'object', properties: { campaign_id: { type: 'string' }, request_text: { type: 'string' }, idempotency_key: { type: 'string' } }, required: ['campaign_id'], additionalProperties: false },
  },
  'workspace.health': {
    description: '查看当前工作区、规则和平台连接状态。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'workspace.bootstrap': {
    description: '首次运行创建商家工作区并返回绑定信息；不会使用演示工作区。',
    inputSchema: { type: 'object', properties: { display_name: { type: 'string' }, external_subject: { type: 'string' } }, required: ['display_name'], additionalProperties: false },
  },
  'workspace.interactive.confirm': {
    description: '商家明确要求生成、编辑、审核或发布后，开启当前 Codex 交互会话的短时写权限；Automation 不得调用。',
    inputSchema: { type: 'object', properties: { confirmation: { type: 'string', enum: ['I_CONFIRM_INTERACTIVE_WRITES'] } }, required: ['confirmation'], additionalProperties: false },
  },
  'workspace.metrics': {
    description: '查看当前工作区的运营指标和任务漏斗。只读。',
    inputSchema: { type: 'object', properties: { platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, account_id: { type: 'string' }, date_from: { type: 'string' }, date_to: { type: 'string' }, risk_limit: { type: 'string' } }, additionalProperties: false },
  },
  'workspace.commercial.get': {
    description: '查看当前工作区套餐价格、额度和平台配置。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'workspace.commercial.update': {
    description: '调整当前工作区套餐价格、店铺数和任务额度。',
    inputSchema: { type: 'object', properties: { plan_code: { type: 'string' }, plan_name: { type: 'string' }, monthly_price_cny: { type: 'string' }, annual_price_cny: { type: 'string' }, included_stores: { type: 'string' }, included_tasks: { type: 'string' }, expected_revision: { type: 'string' } }, required: ['plan_code', 'plan_name'], additionalProperties: false },
  },
  'workspace.usage.get': {
    description: '查看当前工作区本月任务额度使用情况。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'ops.audit.list': {
    description: '查看套餐、额度、平台和退款操作审计。只读。',
    inputSchema: { type: 'object', properties: { limit: { type: 'string' } }, additionalProperties: false },
  },
  'ops.audit.export': { description: '导出当前工作区运营审计和告警处理记录；只读。', inputSchema: { type: 'object', properties: { limit: { type: 'string' }, format: { type: 'string', enum: ['csv', 'json'] } }, additionalProperties: false } },
  'ops.members.list': { description: '查看工作区成员和角色。只读。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  'ops.session': { description: '查看当前运营会话身份、角色和工作区授权范围；不返回凭据。只读。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  'ops.workspaces.list': { description: '查看当前运营者授权工作区的汇总。只读。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  'ops.users.list': { description: '跨工作区查询用户成员关系；仅平台运营可用。只读。', inputSchema: { type: 'object', properties: { query: { type: 'string' }, status: { type: 'string', enum: ['invited', 'active', 'suspended'] }, workspace_id: { type: 'string' }, offset: { type: 'string' }, limit: { type: 'string' } }, additionalProperties: false } },
  'ops.users.export': { description: '按筛选条件导出跨工作区用户成员关系；仅平台运营可用，最多 5000 条。只读。', inputSchema: { type: 'object', properties: { query: { type: 'string' }, status: { type: 'string', enum: ['invited', 'active', 'suspended'] }, workspace_id: { type: 'string' }, limit: { type: 'string' }, format: { type: 'string', enum: ['csv', 'json'] } }, additionalProperties: false } },
  'ops.commercial.export': { description: '导出平台套餐、加购、优惠券和灰度规则；仅平台运营可用，不包含支付密钥。只读。', inputSchema: { type: 'object', properties: { format: { type: 'string', enum: ['csv', 'json'] } }, additionalProperties: false } },
  'ops.user.detail': { description: '查看持久平台身份、脱敏会话、生命周期事件和成员关系；仅平台运营可用。只读。', inputSchema: { type: 'object', properties: { identity_id: { type: 'string' }, issuer: { type: 'string' }, external_subject: { type: 'string' } }, additionalProperties: false } },
  'ops.user.suspend': { description: '停用单个成员关系，或全局停用平台身份并撤销其会话；仅平台运营可用。', inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['membership', 'identity'] }, workspace_id: { type: 'string' }, external_subject: { type: 'string' }, identity_id: { type: 'string' }, expected_revision: { type: 'string' }, idempotency_key: { type: 'string' }, reason: { type: 'string' } }, required: ['reason'], additionalProperties: false } },
  'ops.user.activate': { description: '恢复单个成员关系，或恢复平台身份但不复活旧会话；仅平台运营可用。', inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['membership', 'identity'] }, workspace_id: { type: 'string' }, external_subject: { type: 'string' }, identity_id: { type: 'string' }, expected_revision: { type: 'string' }, idempotency_key: { type: 'string' }, reason: { type: 'string' } }, required: ['reason'], additionalProperties: false } },
  'ops.user.risk.transition': { description: '更新平台身份风险决策；block 会撤销全部活动会话。仅平台运营可用。', inputSchema: { type: 'object', properties: { identity_id: { type: 'string' }, risk_level: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, risk_decision: { type: 'string', enum: ['allow', 'step_up', 'block'] }, expected_revision: { type: 'string' }, idempotency_key: { type: 'string' }, reason: { type: 'string' }, evidence_json: { type: 'string' } }, required: ['identity_id', 'risk_level', 'risk_decision', 'expected_revision', 'idempotency_key', 'reason'], additionalProperties: false } },
  'ops.user.session.revoke': { description: '撤销一个平台认证会话并写入不可变审计；仅平台运营可用。', inputSchema: { type: 'object', properties: { identity_id: { type: 'string' }, session_id: { type: 'string' }, expected_revision: { type: 'string' }, idempotency_key: { type: 'string' }, reason: { type: 'string' } }, required: ['identity_id', 'session_id', 'expected_revision', 'idempotency_key', 'reason'], additionalProperties: false } },
  'ops.commercial.offers.list': { description: '查看可配置套餐目录。只读。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  'ops.commercial.offer.upsert': { description: '创建或调整套餐目录和人民币价格。', inputSchema: { type: 'object', properties: { code: { type: 'string' }, name: { type: 'string' }, billing_cycle: { type: 'string', enum: ['monthly', 'annual'] }, price_cny: { type: 'string' }, included_stores: { type: 'string' }, included_tasks: { type: 'string' }, active: { type: 'string', enum: ['true', 'false'] }, valid_from: { type: 'string' }, valid_to: { type: 'string' }, expected_revision: { type: 'string' }, reason: { type: 'string' } }, required: ['code', 'name', 'billing_cycle', 'price_cny', 'included_stores', 'included_tasks'], additionalProperties: false } },
  'ops.commercial.addons.list': { description: '查看平台和高成本能力加购目录。只读。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  'ops.commercial.addon.upsert': { description: '创建或调整加购能力和人民币价格。', inputSchema: { type: 'object', properties: { code: { type: 'string' }, name: { type: 'string' }, kind: { type: 'string', enum: ['platform', 'image_generation', 'bulk_sync'] }, price_cny: { type: 'string' }, units: { type: 'string' }, active: { type: 'string', enum: ['true', 'false'] }, expected_revision: { type: 'string' }, reason: { type: 'string' } }, required: ['code', 'name', 'kind', 'price_cny', 'units'], additionalProperties: false } },
  'ops.commercial.coupons.list': { description: '查看优惠券目录。只读。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  'ops.commercial.coupon.upsert': { description: '创建或调整优惠券规则。', inputSchema: { type: 'object', properties: { code: { type: 'string' }, discount_type: { type: 'string', enum: ['fixed_cny', 'percent'] }, discount_value: { type: 'string' }, max_redemptions: { type: 'string' }, active: { type: 'string', enum: ['true', 'false'] }, valid_from: { type: 'string' }, valid_to: { type: 'string' }, expected_revision: { type: 'string' }, reason: { type: 'string' } }, required: ['code', 'discount_type', 'discount_value', 'max_redemptions'], additionalProperties: false } },
  'ops.commercial.rollouts.list': { description: '查看套餐灰度规则。只读。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  'ops.commercial.rollout.upsert': { description: '创建或调整套餐灰度规则。', inputSchema: { type: 'object', properties: { offer_code: { type: 'string' }, workspace_id: { type: 'string' }, percentage: { type: 'string' }, enabled: { type: 'string', enum: ['true', 'false'] }, reason: { type: 'string' }, expected_revision: { type: 'string' } }, required: ['offer_code', 'percentage', 'reason'], additionalProperties: false } },
  'ops.growth.funnel': { description: '查看按渠道分组的订阅转化事件漏斗。只读。', inputSchema: { type: 'object', properties: { source_channel: { type: 'string' }, date_from: { type: 'string' }, date_to: { type: 'string' } }, additionalProperties: false } },
  'ops.alerts.list': { description: '查看当前工作区平台运营告警；支持平台、店铺、告警编码和对象筛选。只读。', inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'acknowledged'] }, limit: { type: 'string' }, platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, account_id: { type: 'string' }, code: { type: 'string' }, entity_type: { type: 'string' }, entity_id: { type: 'string' } }, additionalProperties: false } },
  'ops.alert.ack': { description: '确认一条平台运营告警并记录处理原因。', inputSchema: { type: 'object', properties: { alert_id: { type: 'string' }, reason: { type: 'string' } }, required: ['alert_id', 'reason'], additionalProperties: false } },
  'ops.marketing.queue': { description: '查看营销生成、发布异常、视觉候选、学习建议和素材风险队列；支持平台、店铺、商品、任务和状态筛选。只读。', inputSchema: { type: 'object', properties: { limit: { type: 'string' }, platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, account_id: { type: 'string' }, product_id: { type: 'string' }, task_id: { type: 'string' }, state: { type: 'string' } }, additionalProperties: false } },
  'ops.marketing.queue.assign': { description: '为营销队列中的生成或发布任务分配负责人，带版本并发保护和审计记录。', inputSchema: { type: 'object', properties: { item_type: { type: 'string', enum: ['generation', 'publish'] }, item_id: { type: 'string' }, operator_id: { type: 'string' }, expected_revision: { type: 'string' }, reason: { type: 'string' } }, required: ['item_type', 'item_id', 'operator_id', 'reason'], additionalProperties: false } },
  'ops.marketing.visual.review': { description: '审查已归档的视觉候选并标记通过或阻断；不会代替商家选图、内容审核或发布确认。', inputSchema: { type: 'object', properties: { visual_refs_json: { type: 'string' }, status: { type: 'string', enum: ['passed', 'blocked'] }, expected_revision: { type: 'string' }, reason: { type: 'string' } }, required: ['visual_refs_json', 'status', 'reason'], additionalProperties: false } },
  'ops.marketing.generation.retry': { description: '安全重试失败的生成任务。', inputSchema: { type: 'object', properties: { job_id: { type: 'string' }, reason: { type: 'string' } }, required: ['job_id', 'reason'], additionalProperties: false } },
  'ops.marketing.publish.acknowledge': { description: '确认被平台驳回或未知的发布任务，转人工跟进，不重放外部写入。', inputSchema: { type: 'object', properties: { publish_job_id: { type: 'string' }, reason: { type: 'string' } }, required: ['publish_job_id', 'reason'], additionalProperties: false } },
  'ops.marketing.revision.create': { description: '从平台驳回的发布版本创建待审核修正版。', inputSchema: { type: 'object', properties: { publish_job_id: { type: 'string' }, changes_json: { type: 'string' }, locked_fields_json: { type: 'string' }, reason: { type: 'string' }, expected_revision: { type: 'string' } }, required: ['publish_job_id', 'changes_json', 'reason'], additionalProperties: false } },
  'ops.member.upsert': { description: '创建或更新工作区成员角色和状态。', inputSchema: { type: 'object', properties: { external_subject: { type: 'string' }, display_name: { type: 'string' }, role: { type: 'string', enum: ['workspace_owner', 'merchant_admin', 'operator', 'support', 'finance', 'platform_ops'] }, status: { type: 'string', enum: ['invited', 'active', 'suspended'] }, reason: { type: 'string' } }, required: ['external_subject', 'role'], additionalProperties: false } },
  'ops.member.suspend': { description: '停用工作区成员并保留审计。', inputSchema: { type: 'object', properties: { external_subject: { type: 'string' }, reason: { type: 'string' } }, required: ['external_subject', 'reason'], additionalProperties: false } },
  'subscription.get': { description: '查看当前工作区订阅状态和周期。只读。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  'subscription.orders.list': { description: '查看当前工作区订阅订单和价格快照。只读。', inputSchema: { type: 'object', properties: { limit: { type: 'string' } }, additionalProperties: false } },
  'subscription.order.create': { description: '创建订阅支付订单；价格、店铺数和任务额度由服务端套餐目录决定。', inputSchema: { type: 'object', properties: { plan_code: { type: 'string' }, billing_cycle: { type: 'string', enum: ['monthly', 'annual'] }, channel: { type: 'string', enum: ['alipay', 'wechat'] }, coupon_code: { type: 'string' }, addon_codes_json: { type: 'string' }, source_channel: { type: 'string' }, idempotency_key: { type: 'string' } }, required: ['plan_code', 'billing_cycle', 'channel', 'idempotency_key'], additionalProperties: false } },
  'subscription.change': { description: '按服务端套餐目录升级或降级；价格由服务端计算。', inputSchema: { type: 'object', properties: { to_plan_code: { type: 'string' }, billing_cycle: { type: 'string', enum: ['monthly', 'annual'] }, channel: { type: 'string', enum: ['alipay', 'wechat'] }, effective_at: { type: 'string' }, reason: { type: 'string' }, idempotency_key: { type: 'string' } }, required: ['to_plan_code', 'billing_cycle', 'channel', 'reason', 'idempotency_key'], additionalProperties: false } },
  'billing.usage.consume': {
    description: '幂等消耗一个任务额度。',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, idempotency_key: { type: 'string' } }, required: ['task_id', 'idempotency_key'], additionalProperties: false },
  },
  'billing.usage.refund': {
    description: '对失败任务退回额度并记录原因。',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, idempotency_key: { type: 'string' }, reason: { type: 'string' } }, required: ['task_id', 'idempotency_key', 'reason'], additionalProperties: false },
  },
  'billing.refund': { description: '退款一笔已到账充值并记录原因。', inputSchema: { type: 'object', properties: { order_id: { type: 'string' }, reason: { type: 'string' } }, required: ['order_id', 'reason'], additionalProperties: false } },
  'billing.reconciliation': { description: '查看余额、充值、消费和退款汇总。只读。', inputSchema: { type: 'object', properties: { limit: { type: 'string' } }, additionalProperties: false } },
  'billing.reconciliation.run': { description: '由 finance/merchant_admin/platform_ops 运行支付服务商查单对账；已支付订单幂等入账，未知状态保持待处理。', inputSchema: { type: 'object', properties: { limit: { type: 'string' } }, additionalProperties: false } },
  'billing.export': { description: '导出当前工作区账务流水；金额为人民币元并保留两位小数。只读。', inputSchema: { type: 'object', properties: { limit: { type: 'string' }, format: { type: 'string', enum: ['csv', 'json'] } }, additionalProperties: false } },
  'platform.settings.get': {
    description: '查看平台启用状态和店铺展示配置。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'platform.settings.update': {
    description: '调整平台启用状态、展示名称和店铺别名。',
    inputSchema: { type: 'object', properties: { platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, enabled: { type: 'string', enum: ['true', 'false'] }, display_name: { type: 'string' }, store_alias: { type: 'string' }, expected_revision: { type: 'string' }, reason: { type: 'string' } }, required: ['platform', 'reason'], additionalProperties: false },
  },
  'platform.model.status': { description: '查看模型和中转服务可用性。只读。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  'billing.status': {
    description: '查看当前工作区余额、充值渠道和计费模式。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'billing.recharge.create': {
    description: '创建支付宝或微信充值订单；生产环境必须等待支付服务商回调确认后才入账。',
    inputSchema: { type: 'object', properties: { channel: { type: 'string', enum: ['alipay', 'wechat'] }, amount_cny: { type: 'string' }, idempotency_key: { type: 'string' } }, required: ['channel', 'amount_cny'], additionalProperties: false },
  },
  'billing.recharge.get': {
    description: '查询充值订单状态；正式订单只接受支付服务商回调。只读。',
    inputSchema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'], additionalProperties: false },
  },
  'billing.recharge.list': {
    description: '查看当前工作区充值订单，可按逗号分隔的状态筛选。只读。',
    inputSchema: { type: 'object', properties: { states: { type: 'string' }, limit: { type: 'string' } }, additionalProperties: false },
  },
  'billing.transactions': {
    description: '查看当前工作区充值和消费流水。只读。',
    inputSchema: { type: 'object', properties: { limit: { type: 'string' } }, additionalProperties: false },
  },
  'workspace.deactivate': {
    description: '停用商家工作区但不删除任何数据；停用后保留健康检查和重新启用入口。',
    inputSchema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'], additionalProperties: false },
  },
  'workspace.activate': {
    description: '重新启用已停用的商家工作区，不改变已保存的数据。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'ops.data.delete.list': { description: '查看当前工作区数据删除申请；只读。', inputSchema: { type: 'object', properties: { limit: { type: 'string' } }, additionalProperties: false } },
  'ops.data.delete.cancel': { description: '取消尚未执行的数据删除申请；实际删除不在此接口执行。', inputSchema: { type: 'object', properties: { request_id: { type: 'string' }, reason: { type: 'string' } }, required: ['request_id', 'reason'], additionalProperties: false } },
  'ops.data.delete.approve': { description: '记录一名独立运营人员的删除审批；第二次审批后仍需外部删除执行与证明。', inputSchema: { type: 'object', properties: { request_id: { type: 'string' }, reason: { type: 'string' } }, required: ['request_id', 'reason'], additionalProperties: false } },
  'workspace.data.delete.request': { description: '登记数据删除申请；仅进入宽限期和双人审批流程，不立即删除数据。', inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['workspace', 'assets', 'business'] }, reason: { type: 'string' }, idempotency_key: { type: 'string' } }, required: ['scope', 'reason', 'idempotency_key'], additionalProperties: false } },
  'platform.connect': {
    description: '发起指定平台官方 OAuth 授权；不会接触商家密码。',
    inputSchema: { type: 'object', properties: { platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, redirect_uri: { type: 'string' }, actor_id: { type: 'string' }, store_key: { type: 'string', description: '仅 fixture 演练使用的店铺选择键；真实 OAuth 使用回调返回的远端账号。' } }, required: ['platform'], additionalProperties: false },
  },
  'platform.store.alias.set': {
    description: '为明确的平台账号设置商家可读店铺别名；同平台别名必须唯一。',
    inputSchema: { type: 'object', properties: { platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, account_id: { type: 'string' }, alias: { type: 'string' }, expected_revision: { type: 'string' } }, required: ['platform', 'account_id', 'alias', 'expected_revision'], additionalProperties: false },
  },
  'catalog.search': {
    description: '搜索商品；指定店铺必须同时提供平台和 account_id，全部店铺汇总必须明确 scope=workspace。结果包含逐商品店铺绑定或事实确认下一步。只读。',
    inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['store', 'workspace'], description: '默认选择具体店铺；只有明确 scope=workspace 才查询全部店铺。' }, query: { type: 'string' }, platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, account_id: { type: 'string' }, store_name: { type: 'string' }, brand_name: { type: 'string' }, sku_id: { type: 'string' }, remote_product_id: { type: 'string' }, listing_status: { type: 'string', enum: ['on_sale', 'off_sale', 'draft', 'unknown'] }, product_state: { type: 'string', enum: ['active', 'disabled'] }, sync_status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'partial', 'failed'] }, date_from: { type: 'string' }, date_to: { type: 'string' } }, additionalProperties: false },
  },
  'catalog.categories': {
    description: '查询品类库，返回品类名称、平台范围和必填属性模板。只读。',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false },
  },
  'catalog.title.optimize': {
    description: '基于商品事实生成 SEO/GEO 标题建议；不承诺排名，必须人工确认。',
    inputSchema: { type: 'object', properties: { product_id: { type: 'string' }, platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, keyword: { type: 'string' }, objective: { type: 'string' } }, required: ['product_id'], additionalProperties: false },
  },
  'catalog.title.accept': { description: '人工确认 SEO/GEO 标题建议并写回商品；写回后必须重新确认商品事实。', inputSchema: { type: 'object', properties: { product_id: { type: 'string' }, platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, suggestion_id: { type: 'string' }, title: { type: 'string' }, actor_id: { type: 'string' }, expected_version: { type: 'string' } }, required: ['product_id', 'platform', 'suggestion_id', 'title'], additionalProperties: false } },
  'publish.batch.prepare': {
    description: '为最多 50 个已批准任务生成可恢复的批量发布预览。',
    inputSchema: { type: 'object', properties: { task_ids_json: { type: 'string' } }, required: ['task_ids_json'], additionalProperties: false },
  },
  'publish.batch.confirm': {
    description: '逐项确认并排队批量商品发布；每项独立记录回执和失败原因。',
    inputSchema: { type: 'object', properties: { batch_id: { type: 'string' }, confirmations_json: { type: 'string' } }, required: ['batch_id', 'confirmations_json'], additionalProperties: false },
  },
  'publish.batch.get': { description: '读取可恢复的批量发布状态。', inputSchema: { type: 'object', properties: { batch_id: { type: 'string' } }, required: ['batch_id'], additionalProperties: false } },
  'publish.batch.pause': { description: '暂停批次后续确认和重试。', inputSchema: { type: 'object', properties: { batch_id: { type: 'string' }, reason: { type: 'string' } }, required: ['batch_id', 'reason'], additionalProperties: false } },
  'publish.batch.resume': { description: '恢复批次的人工确认和失败项重试。', inputSchema: { type: 'object', properties: { batch_id: { type: 'string' } }, required: ['batch_id'], additionalProperties: false } },
  'publish.batch.retry_failed': { description: '使用新的确认哈希重新校验并排队批次失败项。', inputSchema: { type: 'object', properties: { batch_id: { type: 'string' }, confirmations_json: { type: 'string' } }, required: ['batch_id', 'confirmations_json'], additionalProperties: false } },
  'automation.policy.get': { description: '查看店铺自动化运营策略。', inputSchema: { type: 'object', properties: { platform: { type: 'string' }, account_id: { type: 'string' } }, additionalProperties: false } },
  'automation.policy.list': { description: '列出当前工作区所有已配置的店铺自动化策略及暂停状态。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  'automation.policy.update': { description: '配置店铺商品同步、风险告警和人工重试策略。', inputSchema: { type: 'object', properties: { platform: { type: 'string' }, account_id: { type: 'string' }, enabled: { type: 'string', enum: ['true', 'false'] }, sync_enabled: { type: 'string', enum: ['true', 'false'] }, frequency_minutes: { type: 'string' }, retry_limit: { type: 'string' }, window_start: { type: 'string' }, window_end: { type: 'string' }, clear_window: { type: 'string', enum: ['true', 'false'] }, reason: { type: 'string' } }, required: ['enabled', 'reason'], additionalProperties: false } },
  'automation.scan': { description: '执行只读店铺健康扫描并返回结构化优化建议；建议动作仍需交互确认。', inputSchema: { type: 'object', properties: { platform: { type: 'string' }, account_id: { type: 'string' } }, additionalProperties: false } },
  'automation.tick': { description: '执行已到期的店铺同步与风险扫描策略；不自动重发或发布。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  'automation.pause': { description: '暂停店铺自动化运营并记录原因。', inputSchema: { type: 'object', properties: { platform: { type: 'string' }, account_id: { type: 'string' }, reason: { type: 'string' } }, required: ['reason'], additionalProperties: false } },
  'catalog.import': {
    description: '导入或绑定商品；支持后续主图生成和发布。',
    inputSchema: { type: 'object', properties: { platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, account_id: { type: 'string' }, remote_id: { type: 'string' }, local_product_key: { type: 'string' }, title: { type: 'string' }, category: { type: 'string' }, price: { type: 'string' }, stock: { type: 'string' }, sku_count: { type: 'string' }, skus_json: { type: 'string' }, images: { type: 'string' }, asset_ids_json: { type: 'string', description: '已上传商品素材 ID 字符串数组 JSON' }, attributes_json: { type: 'string' }, selling_points_json: { type: 'string' }, store_name: { type: 'string' }, store_differentiation: { type: 'string' } }, required: ['platform', 'title'], additionalProperties: false },
  },
  'catalog.import.batch': {
    description: '批量导入最多 50 个商品；每项明确平台和店铺，全部预校验通过后才写入。',
    inputSchema: { type: 'object', properties: { products_json: { type: 'string', description: '商品对象数组 JSON' } }, required: ['products_json'], additionalProperties: false },
  },
  'catalog.sku.update': { description: '独立修改商品 SKU 的名称、价格、库存、图片和规格；修改后必须重新确认商品事实。', inputSchema: { type: 'object', properties: { product_id: { type: 'string' }, sku_id: { type: 'string' }, name: { type: 'string' }, price: { type: 'string' }, stock: { type: 'string' }, images_json: { type: 'string' }, attributes_json: { type: 'string' }, expected_version: { type: 'string' } }, required: ['product_id', 'sku_id'], additionalProperties: false } },
  'catalog.product.update': { description: '修改商品级标题、类目、主副图、属性、卖点和店铺差异化；修改后必须重新确认商品事实。', inputSchema: { type: 'object', properties: { product_id: { type: 'string' }, title: { type: 'string' }, category: { type: 'string' }, images_json: { type: 'string' }, attributes_json: { type: 'string' }, selling_points_json: { type: 'string' }, store_differentiation: { type: 'string' }, price: { type: 'string' }, expected_version: { type: 'string' } }, required: ['product_id'], additionalProperties: false } },
  'catalog.facts.confirm': {
    description: '确认商品、SKU、价格和图片等事实，之后才能正式生成或发布。',
    inputSchema: { type: 'object', properties: { product_id: { type: 'string' } }, required: ['product_id'], additionalProperties: false },
  },
  'catalog.product.disable': {
    description: '停用商品但保留快照和历史任务；停用后不能创建新任务。',
    inputSchema: { type: 'object', properties: { product_id: { type: 'string' }, reason: { type: 'string' } }, required: ['product_id', 'reason'], additionalProperties: false },
  },
  'catalog.product.enable': {
    description: '恢复已停用商品；保留历史快照和任务审计。',
    inputSchema: { type: 'object', properties: { product_id: { type: 'string' } }, required: ['product_id'], additionalProperties: false },
  },
  'catalog.image.generate': {
    description: '根据已确认商品事实生成商品主图变体；返回可追踪的异步任务。',
    inputSchema: { type: 'object', properties: { product_id: { type: 'string' }, platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, account_id: { type: 'string', description: '可选店铺上下文；必须与商品绑定的平台和店铺一致。' }, task_id: { type: 'string' }, content_version_id: { type: 'string' }, mode: { type: 'string', enum: ['create', 'optimize'], description: 'create 从零设计；optimize 必须基于已授权上传素材。' }, sku_ids_json: { type: 'string', description: '要生成图片的 SKU ID 字符串数组 JSON；默认使用任务冻结 SKU 范围。' }, asset_ids_json: { type: 'string', description: '已上传且通过扫描/权益/AI 修改检查的商品图片素材 ID 数组 JSON；优化模式必填。' }, direction: { type: 'string' }, count: { type: 'string' }, idempotency_key: { type: 'string' } }, required: ['product_id'], additionalProperties: false },
  },
  'catalog.image.get': {
    description: '查询商品主图生成任务及结果。',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' }, visual_ref: { type: 'string' } }, additionalProperties: false },
  },
  'catalog.image.review': {
    description: '检查商品主图链接、缺失和重复问题，并将校验结果持久化到候选任务的审查快照。',
    inputSchema: { type: 'object', properties: { product_id: { type: 'string' }, images: { type: 'string' }, visual_refs_json: { type: 'string' } }, required: ['product_id'], additionalProperties: false },
  },
  'sync.retry_failed': {
    description: '重试商品同步中可重试的失败项。',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' }, failure_ids_json: { type: 'string' } }, required: ['job_id'], additionalProperties: false },
  },
  'rule.list': {
    description: '查看当前工作区生效的规则包。',
    inputSchema: { type: 'object', properties: { platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, category: { type: 'string' }, brand: { type: 'string' }, store: { type: 'string' }, campaign: { type: 'string' } }, additionalProperties: false },
  },
  'rule.sync.status': {
    description: '查看六个平台规则来源、版本新鲜度和可信清单配置状态。',
    inputSchema: { type: 'object', properties: { interval_hours: { type: 'string' } }, additionalProperties: false },
  },
  'rule.history': {
    description: '查看规则包的不可变历史版本。',
    inputSchema: { type: 'object', properties: { pack_id: { type: 'string' } }, required: ['pack_id'], additionalProperties: false },
  },
  'rule.audit': {
    description: '查看规则发布、激活、停用和过期审计记录。',
    inputSchema: { type: 'object', properties: { pack_id: { type: 'string' } }, additionalProperties: false },
  },
  'rule.publish': {
    description: '创建不可变规则版本；激活规则需要规则管理员身份和审批证据。approval_json 需包含 approval_ref、approved_by、approved_at。',
    inputSchema: { type: 'object', properties: { pack_id: { type: 'string' }, name: { type: 'string' }, version: { type: 'string' }, scope: { type: 'string', enum: ['global', 'platform', 'category', 'brand', 'store', 'campaign'] }, source_kind: { type: 'string', enum: ['official', 'internal', 'legal_review'] }, source_reference: { type: 'string' }, source_checked_at: { type: 'string' }, effective_from: { type: 'string' }, effective_to: { type: 'string' }, severity: { type: 'string', enum: ['error', 'warning'] }, action: { type: 'string', enum: ['block', 'warn', 'review', 'allow'] }, target_id: { type: 'string' }, scope_value: { type: 'string' }, checks_json: { type: 'string' }, reason: { type: 'string' }, status: { type: 'string', enum: ['draft', 'active'] }, approval_json: { type: 'string' } }, required: ['pack_id', 'name', 'version', 'scope', 'source_kind', 'source_reference', 'source_checked_at', 'checks_json', 'reason'], additionalProperties: false },
  },
  'rule.status': {
    description: '变更规则版本状态并留下审计记录；激活时 approval_json 需包含 approval_ref、approved_by、approved_at。',
    inputSchema: { type: 'object', properties: { pack_id: { type: 'string' }, version: { type: 'string' }, status: { type: 'string', enum: ['active', 'inactive', 'expired'] }, reason: { type: 'string' }, approval_json: { type: 'string' } }, required: ['pack_id', 'version', 'status', 'reason'], additionalProperties: false },
  },
  'asset.list': {
    description: '查看工作区素材、扫描和权益状态。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'asset.parse': {
    description: '解析已完成安全扫描的文本或 JSON 素材。',
    inputSchema: { type: 'object', properties: { asset_id: { type: 'string' } }, required: ['asset_id'], additionalProperties: false },
  },
  'asset.facts.confirm': {
    description: '自动解析或 OCR 不可用时，由商家人工补录并确认素材事实；保留人工来源、确认人和原因。',
    inputSchema: { type: 'object', properties: { asset_id: { type: 'string' }, facts_json: { type: 'string' }, reason: { type: 'string' } }, required: ['asset_id', 'facts_json', 'reason'], additionalProperties: false },
  },
  'asset.preference.update': {
    description: '记录或清除商家对历史素材的“优秀/不喜欢”评价；优秀或不喜欢必须填写原因。',
    inputSchema: { type: 'object', properties: { asset_id: { type: 'string' }, verdict: { type: 'string', enum: ['excellent', 'disliked', 'unrated'] }, reasons_json: { type: 'string' }, note: { type: 'string' }, expected_revision: { type: 'string' } }, required: ['asset_id', 'verdict'], additionalProperties: false },
  },
  'brand.get': {
    description: '查看当前工作区品牌档案。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'brand.extract': {
    description: '从已读取的品牌素材提取候选字段、来源和置信度；只读且不会自动写入品牌档案。',
    inputSchema: { type: 'object', properties: { asset_ids_json: { type: 'string', description: '可选：1～50 个素材 ID 的 JSON 字符串数组；省略时检查全部工作区素材。' } }, additionalProperties: false },
  },
  'brand.upsert': {
    description: '保存品牌档案新版本及已确认的 Logo、品牌色和字体强规则。',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, positioning: { type: 'string' }, audience: { type: 'string' }, tone_json: { type: 'string' }, forbidden_terms_json: { type: 'string' }, details_json: { type: 'string' }, visual_rules_json: { type: 'string' }, source: { type: 'string' }, conflict_resolutions_json: { type: 'string' } }, required: ['name'], additionalProperties: false },
  },
  'brand.tone.preview': {
    description: '品牌调性未确定时生成三段短试写，供商家选择方向。',
    inputSchema: { type: 'object', properties: { topic: { type: 'string' }, product_id: { type: 'string' } }, additionalProperties: false },
  },
  'asset.upload': {
    description: '上传用户已附加的本地素材到隔离区。附件优先传绝对 file_path，由 bridge 读取文件；不要在终端生成或向模型传递 base64。也兼容小型内容的 content_base64。单文件最多 50MB。',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, mime_type: { type: 'string' }, file_path: { type: 'string', description: '用户在当前会话明确附加的本地文件绝对路径。' }, content_base64: { type: 'string', description: '仅用于已经很小的内联内容；本地附件请使用 file_path。' }, sha256: { type: 'string' }, rights_scope: { type: 'string', enum: ['owned', 'commercial_authorized', 'limited_use', 'internal_only', 'unknown', 'unusable'] }, applicable_platforms_json: { type: 'string' }, applicable_regions_json: { type: 'string' }, usage_scopes_json: { type: 'string' }, valid_from: { type: 'string' }, valid_to: { type: 'string' }, ai_modification_allowed: { type: 'string', enum: ['true', 'false'] } }, required: ['name', 'mime_type'], oneOf: [{ required: ['file_path'] }, { required: ['content_base64'] }], additionalProperties: false },
  },
  'asset.upload.batch': {
    description: '批量上传素材到隔离区；单批最多20个、总大小最多250MB。assets_json 必须是 JSON 数组字符串，每项至少包含 name、mime_type、content_base64，可选 rights_scope、applicable_platforms_json、applicable_regions_json、usage_scopes_json、valid_from、valid_to、ai_modification_allowed（true/false 字符串）。',
    inputSchema: { type: 'object', properties: { assets_json: { type: 'string' } }, required: ['assets_json'], additionalProperties: false },
  },
  'asset.scan': {
    description: '提供外部扫描证据后提升隔离素材。',
    inputSchema: { type: 'object', properties: { asset_id: { type: 'string' }, scan_evidence_ref: { type: 'string' } }, required: ['asset_id', 'scan_evidence_ref'], additionalProperties: false },
  },
  'asset.rights.update': {
    description: '记录人工确认的素材版权状态，不修改原始文件。',
    inputSchema: { type: 'object', properties: { asset_id: { type: 'string' }, rights_status: { type: 'string', enum: ['approved', 'rejected', 'pending'] }, rights_scope: { type: 'string', enum: ['owned', 'commercial_authorized', 'limited_use', 'internal_only', 'unknown', 'unusable'] }, applicable_platforms_json: { type: 'string' }, applicable_regions_json: { type: 'string' }, usage_scopes_json: { type: 'string' }, valid_from: { type: 'string' }, valid_to: { type: 'string' }, ai_modification_allowed: { type: 'string', enum: ['true', 'false'] } }, required: ['asset_id', 'rights_status'], additionalProperties: false },
  },
  'catalog.sync': {
    description: '从已授权平台同步商品事实、SKU、库存和平台字段；部分失败不会伪装成全量成功。',
    inputSchema: {
      type: 'object',
      properties: { platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, account_id: { type: 'string' }, cursor: { type: 'string' } },
      required: ['platform'],
      additionalProperties: false,
    },
  },
  'catalog.sync.start': {
    description: '创建可恢复的商品同步任务并返回任务句柄；实际同步由独立 Worker 执行。',
    inputSchema: {
      type: 'object',
      properties: { platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, account_id: { type: 'string' }, mode: { type: 'string', enum: ['full', 'incremental'] }, cursor: { type: 'string' } },
      required: ['platform'],
      additionalProperties: false,
    },
  },
  'catalog.sync.get': {
    description: '查询可恢复商品同步任务的状态、页数和游标。',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'], additionalProperties: false },
  },
  'deliverable.list': {
    description: '分页查找已生成内容版本的虚拟交付索引。只返回摘要，不返回正文、图片、输入素材或预生成文件。只读。',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, account_id: { type: 'string' }, product_id: { type: 'string' }, task_id: { type: 'string' }, state: { type: 'string', enum: ['draft', 'review_required', 'approved', 'delivered'] }, date_from: { type: 'string' }, date_to: { type: 'string' }, limit: { type: 'string' }, cursor: { type: 'string' } }, additionalProperties: false },
  },
  'task.history': {
    description: '搜索当前工作区的历史营销任务。只读。',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, state: { type: 'string' }, product_id: { type: 'string' }, account_id: { type: 'string' }, brand_name: { type: 'string' }, store_name: { type: 'string' }, remote_product_id: { type: 'string' }, publish_status: { type: 'string', enum: ['prepared', 'confirmed', 'queued', 'submitting', 'submitted', 'reviewing', 'published', 'rejected', 'unknown', 'reconciling', 'manual_attention'] }, date_from: { type: 'string' }, date_to: { type: 'string' } }, additionalProperties: false },
  },
  'task.resume': {
    description: '恢复任务并展示持久化的待回答/暂缓问题卡；只读，不会自动回答或生成。',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'], additionalProperties: false },
  },
  'task.clone': {
    description: '从历史任务创建新的草稿任务，不复制过期内容和活动价格。',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, request_text: { type: 'string' }, target_product_id: { type: 'string' }, target_platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, target_account_id: { type: 'string' }, region: { type: 'string' } }, required: ['task_id'], additionalProperties: false },
  },
  'task.timeline': {
    description: '查看任务的持久化时间线，包括版本、确认、失败和交付事件。只读。',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, limit: { type: 'string' } }, required: ['task_id'], additionalProperties: false },
  },
  'feedback.list': {
    description: '查看当前任务的交付后反馈；不会修改全局规则。',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'], additionalProperties: false },
  },
  'feedback.submit': {
    description: '提交当前任务内容的评价和可选原因；反馈只作用于当前任务分析。',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, content_version_id: { type: 'string' }, rating: { type: 'string', enum: ['liked', 'neutral', 'needs_improvement'] }, reason: { type: 'string' }, comment: { type: 'string' } }, required: ['task_id', 'rating'], additionalProperties: false },
  },
  'platform.revoke': {
    description: '撤销指定平台账号授权；立即停止同步和发布，并保留商品快照与审计记录。',
    inputSchema: {
      type: 'object',
      properties: { platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, account_id: { type: 'string' } },
      required: ['platform', 'account_id'],
      additionalProperties: false,
    },
  },
  'task.create': {
    description: '为一个商品和一个平台创建营销任务。',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string' },
        platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] },
        account_id: { type: 'string' },
        region: { type: 'string', description: '素材权益匹配用的明确地区/市场代码或名称。' },
      },
      required: ['product_id', 'platform'],
      additionalProperties: false,
    },
  },
  'task.answer': {
    description: '回答任务理解问题并保存可恢复的输入快照；answers_json 可包含 promotion_json，金额为人民币元且最多两位小数。',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, answers_json: { type: 'string' }, expected_version: { type: 'string' } }, required: ['task_id', 'answers_json'], additionalProperties: false },
  },
  'task.understand': {
    description: '解析自然语言任务，返回候选商品、平台和阻断问题。',
    inputSchema: { type: 'object', properties: { request_text: { type: 'string' } }, required: ['request_text'], additionalProperties: false },
  },
  'task.request.create': {
    description: '当自然语言请求中的每个平台都能唯一绑定商品时，直接创建单任务或独立多平台任务组；否则返回需要澄清的绑定信息。',
    inputSchema: { type: 'object', properties: { request_text: { type: 'string' }, idempotency_key: { type: 'string' } }, required: ['request_text'], additionalProperties: false },
  },
  'task.sku.split': {
    description: '把未确认方案的多 SKU 任务原子拆成每个 SKU 一个独立子任务/交付包；每个子任务保留自己的价格、库存、事实、图片和发布流程。',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, idempotency_key: { type: 'string' } }, required: ['task_id'], additionalProperties: false },
  },
  'task.group.create': {
    description: '批量生成入口：为多个平台/店铺/SKU 创建彼此独立的营销子任务；同一平台同一店铺仅允许不同 sku_id 分别出现，每项可提供 region 以匹配素材权益地区。必须先从当前品和商品列表多选，不能跨品复用选择。',
    inputSchema: { type: 'object', properties: { entries_json: { type: 'string' }, request_text: { type: 'string' } }, required: ['entries_json'], additionalProperties: false },
  },
  'creative.directions': {
    description: '为任务返回三个可审阅的创意方向。',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'], additionalProperties: false },
  },
  'creative.brief': {
    description: '基于已确认商品事实生成 Banner、广告素材矩阵或视频脚本/分镜 Brief；只生成结构化方案，不渲染媒体、不自动投放。',
    inputSchema: { type: 'object', properties: { product_id: { type: 'string' }, asset_type: { type: 'string', enum: ['banner', 'ad', 'video_storyboard'] }, platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, placement: { type: 'string' }, goal: { type: 'string' }, audience: { type: 'string' }, dimensions_json: { type: 'string' }, duration_seconds: { type: 'string' }, text_density: { type: 'string', enum: ['none', 'single_selling_point', 'title_and_subtitle', 'promotion'] }, sku_ids_json: { type: 'string' }, promotion_json: { type: 'string' } }, required: ['product_id', 'asset_type'], additionalProperties: false },
  },
  'creative.preview': {
    description: '为已确认商品生成 Banner 或广告素材的可审阅 SVG 预览；不上传、不投放、不代表平台审核通过。',
    inputSchema: { type: 'object', properties: { product_id: { type: 'string' }, asset_type: { type: 'string', enum: ['banner', 'ad'] }, platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, text_density: { type: 'string', enum: ['none', 'single_selling_point', 'title_and_subtitle', 'promotion'] }, count: { type: 'string' } }, required: ['product_id', 'asset_type'], additionalProperties: false },
  },
  'creative.directions.update': {
    description: '重新生成、合并或修改创意方向，并产生新的任务版本。',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, action: { type: 'string', enum: ['regenerate', 'merge', 'modify'] }, direction_ids_json: { type: 'string' }, direction_id: { type: 'string' }, changes_json: { type: 'string' }, feedback: { type: 'string' }, expected_version: { type: 'string' } }, required: ['task_id', 'action'], additionalProperties: false },
  },
  'task.select_direction': {
    description: '为营销任务选择方向；未选择方向不能生成正式内容。',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, direction_id: { type: 'string' }, expected_version: { type: 'string' } },
      required: ['task_id', 'direction_id'],
      additionalProperties: false,
    },
  },
  'task.plan.confirm': {
    description: '确认制作方案；返回冻结的促销快照和逐 SKU 价格 diff。商家确认价格影响后才能继续生成正式内容。',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, actor_id: { type: 'string' }, expected_version: { type: 'string' }, price_impact_confirmed: { type: 'string', enum: ['true', 'false'] } }, required: ['task_id'], additionalProperties: false },
  },
  'content.generate': {
    description: '基于任务和已确认商品事实生成新的可审阅内容版本。',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, idempotency_key: { type: 'string' } }, required: ['task_id'], additionalProperties: false },
  },
  'content.codex.prepare': {
    description: '仅本地开发/测试：准备已确认商品事实和结构化输出契约供 Codex 会话生成。生产环境禁止调用，正式生成必须使用平台托管并计量 token 的 content.generate。',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'], additionalProperties: false },
  },
  'content.codex.commit': {
    description: '仅本地开发/测试：提交当前 Codex 会话生成的待审核版本。生产环境禁止调用，不能绕过平台模型计量；正式生成必须使用 content.generate。',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, body_json: { type: 'string' }, reason: { type: 'string' } }, required: ['task_id', 'body_json'], additionalProperties: false },
  },
  'generation.get': {
    description: '读取异步内容生成任务状态；完成后返回内容版本引用。',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'], additionalProperties: false },
  },
  'content.review': {
    description: '执行确定性规则检查，返回阻断项和可追溯 finding。',
    inputSchema: { type: 'object', properties: { content_version_id: { type: 'string' } }, required: ['content_version_id'], additionalProperties: false },
  },
  'content.review.decide': {
    description: '标记 P1/P2 审核建议为已知悉或带理由接受；P0 阻断项不能绕过。',
    inputSchema: { type: 'object', properties: { content_version_id: { type: 'string' }, code: { type: 'string' }, field: { type: 'string' }, status: { type: 'string', enum: ['acknowledged', 'waived'] }, reason: { type: 'string' }, expected_revision: { type: 'string' } }, required: ['content_version_id', 'code', 'field', 'status'], additionalProperties: false },
  },
  'content.visual.select': {
    description: '把已检查的候选图按明确顺序绑定到一个新的待审核内容版本；不会批准或发布。',
    inputSchema: { type: 'object', properties: { content_version_id: { type: 'string' }, visual_refs_json: { type: 'string' }, expected_revision: { type: 'string' }, idempotency_key: { type: 'string' }, reason: { type: 'string' } }, required: ['content_version_id', 'visual_refs_json', 'expected_revision', 'reason'], additionalProperties: false },
  },
  'content.versions': {
    description: '列出任务的不可变内容版本。',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'], additionalProperties: false },
  },
  'content.diff': {
    description: '比较同一任务的两个内容版本，不覆盖历史版本。',
    inputSchema: { type: 'object', properties: { content_version_id: { type: 'string' }, against_version_id: { type: 'string' } }, required: ['content_version_id'], additionalProperties: false },
  },
  'content.export': {
    description: '为明确选中的内容版本或公开交付引用按需生成导出；不会伪造下载附件或平台回执。',
    inputSchema: { type: 'object', properties: { content_version_id: { type: 'string' }, deliverable_ref: { type: 'string' }, format: { type: 'string', enum: ['manifest', 'json', 'markdown', 'bundle'] } }, additionalProperties: false },
  },
  'content.approve': {
    description: '批准指定的不可变内容版本；批准前必须先完成人工审阅，可用 expected_version 防止并发覆盖。',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, content_version_id: { type: 'string' }, expected_version: { type: 'string' } },
      required: ['task_id', 'content_version_id'],
      additionalProperties: false,
    },
  },
  'content.modify': {
    description: '按字段局部修改，或只重生成一个详情模块并创建新版本；锁定字段不会被覆盖。',
    inputSchema: { type: 'object', properties: { content_version_id: { type: 'string' }, changes_json: { type: 'string' }, module_key: { type: 'string' }, locked_fields_json: { type: 'string' }, reason: { type: 'string' }, expected_revision: { type: 'string' } }, required: ['content_version_id', 'reason'], additionalProperties: false },
  },
  'content.restore': {
    description: '从历史内容版本恢复并创建新的待审核版本，不覆盖历史。',
    inputSchema: { type: 'object', properties: { content_version_id: { type: 'string' }, expected_version: { type: 'string' } }, required: ['content_version_id'], additionalProperties: false },
  },
  'publish.prepare': {
    description: '生成发布预览、远端快照和确认哈希；不会写入平台。',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
  'publish.confirm': {
    description: '在用户明确确认且哈希仍然新鲜时受理发布；不代表已发布。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        content_version_id: { type: 'string' },
        confirmation_hash: { type: 'string' },
        remote_snapshot_hash: { type: 'string' },
        account_id: { type: 'string' },
      },
      required: ['task_id', 'content_version_id', 'confirmation_hash', 'remote_snapshot_hash'],
      additionalProperties: false,
    },
  },
  'publish.get': {
    description: '查询发布任务当前状态和平台回执。',
    inputSchema: { type: 'object', properties: { publish_job_id: { type: 'string' } }, required: ['publish_job_id'], additionalProperties: false },
  },
  'knowledge.rule.create': {
    description: '录入平台、品类、品牌、店铺或大促节点规则，形成可追溯的规则版本。',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' }, scope: { type: 'string', enum: ['global', 'platform', 'category', 'brand', 'store', 'campaign'] }, scope_value: { type: 'string' }, platform: { type: 'string' }, category: { type: 'string' }, brand: { type: 'string' }, store: { type: 'string' }, campaign: { type: 'string' }, source_kind: { type: 'string', enum: ['official', 'internal', 'merchant', 'observed', 'legal_review'] }, source_reference: { type: 'string' }, source_checked_at: { type: 'string' }, version: { type: 'string' }, severity: { type: 'string', enum: ['info', 'warning', 'error'] }, action: { type: 'string', enum: ['warn', 'block', 'require_confirmation', 'suggest'] }, owner_id: { type: 'string' }, status: { type: 'string', enum: ['draft', 'active', 'inactive', 'archived'] }, effective_from: { type: 'string' }, effective_to: { type: 'string' }, tags_json: { type: 'string' } }, required: ['name', 'content', 'scope', 'source_kind', 'source_reference', 'source_checked_at', 'version', 'status'], additionalProperties: false },
  },
  'knowledge.rule.list': {
    description: '查询当前可用的平台、品类、品牌、店铺和大促规则。只读。',
    inputSchema: { type: 'object', properties: { scope: { type: 'string' }, scope_value: { type: 'string' }, status: { type: 'string' }, as_of: { type: 'string' }, platform: { type: 'string' }, category: { type: 'string' }, brand: { type: 'string' }, store: { type: 'string' }, campaign: { type: 'string' }, text: { type: 'string' } }, additionalProperties: false },
  },
  'knowledge.asset.create': {
    description: '录入品牌资产或客户资产，供后续内容生成使用。',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['brand', 'customer'] }, name: { type: 'string' }, content_json: { type: 'string' }, source: { type: 'string' }, tags_json: { type: 'string' }, approval_status: { type: 'string', enum: ['pending', 'approved', 'rejected'] }, rights_status: { type: 'string', enum: ['unknown', 'cleared', 'restricted'] } }, required: ['kind', 'name', 'content_json'], additionalProperties: false },
  },
  'knowledge.asset.update': {
    description: '更新知识资产的审批、权益或内容，并保留运营审计。',
    inputSchema: { type: 'object', properties: { asset_id: { type: 'string' }, name: { type: 'string' }, content_json: { type: 'string' }, source: { type: 'string' }, tags_json: { type: 'string' }, approval_status: { type: 'string', enum: ['pending', 'approved', 'rejected'] }, rights_status: { type: 'string', enum: ['unknown', 'cleared', 'restricted'] } }, required: ['asset_id'], additionalProperties: false },
  },
  'knowledge.asset.list': {
    description: '查询当前工作区的品牌资产和客户资产。只读。',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['brand', 'customer'] }, text: { type: 'string' }, tags_json: { type: 'string' } }, additionalProperties: false },
  },
  'knowledge.feedback.record': {
    description: '记录客户反馈或平台驳回，并生成待确认的规范学习建议。',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['feedback', 'platform_rejection'] }, platform: { type: 'string' }, content_id: { type: 'string' }, reason: { type: 'string' }, details: { type: 'string' }, metadata_json: { type: 'string' } }, required: ['kind', 'reason'], additionalProperties: false },
  },
  'knowledge.learning.list': {
    description: '查看由反馈和驳回事件产生的规范学习建议。只读。',
    inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'confirmed', 'dismissed'] } }, additionalProperties: false },
  },
  'knowledge.learning.confirm': {
    description: '确认一条学习建议；确认只沉淀为建议记录，不会绕过审核自动启用规则。',
    inputSchema: { type: 'object', properties: { suggestion_id: { type: 'string' }, note: { type: 'string' } }, required: ['suggestion_id'], additionalProperties: false },
  },
  'knowledge.learning.dismiss': {
    description: '驳回一条学习建议并记录原因，不会激活全局规则。',
    inputSchema: { type: 'object', properties: { suggestion_id: { type: 'string' }, note: { type: 'string' } }, required: ['suggestion_id'], additionalProperties: false },
  },
  'knowledge.competitor.create': {
    description: '录入竞品公开信息并生成结构化分析；禁止提交竞品原文或复制内容。',
    inputSchema: { type: 'object', properties: { competitor_name: { type: 'string' }, source_json: { type: 'string' }, summary: { type: 'string' }, structure_json: { type: 'string' }, selling_points_json: { type: 'string' }, expression_json: { type: 'string' } }, required: ['competitor_name', 'source_json', 'summary', 'structure_json', 'selling_points_json', 'expression_json'], additionalProperties: false },
  },
  'knowledge.competitor.list': {
    description: '查询当前工作区的竞品分析记录。只读。',
    inputSchema: { type: 'object', properties: { competitor_name: { type: 'string' }, text: { type: 'string' } }, additionalProperties: false },
  },
  'knowledge.competitor.reference': {
    description: '基于竞品分析生成差异化参考方向，不复制竞品表达。',
    inputSchema: { type: 'object', properties: { competitor_id: { type: 'string' }, own_brand_name: { type: 'string' }, own_selling_points_json: { type: 'string' } }, required: ['competitor_id', 'own_brand_name', 'own_selling_points_json'], additionalProperties: false },
  },
  'multimodal.image.edit': {
    description: '根据图片区域标注创建新的局部修改候选版本，保留原图并等待审核。',
    inputSchema: { type: 'object', properties: { request_json: { type: 'string' } }, required: ['request_json'], additionalProperties: false },
  },
  'multimodal.generate': {
    description: '用一句话发起文案、图片或视频脚本/分镜候选请求，返回结果会明确标识是否已由 provider 执行。',
    inputSchema: { type: 'object', properties: { modality: { type: 'string', enum: ['text', 'image', 'video'] }, prompt: { type: 'string' }, output: { type: 'string', enum: ['script', 'storyboard', 'rendering'] }, context_json: { type: 'string' } }, required: ['modality', 'prompt', 'context_json'], additionalProperties: false },
  },
  'multimodal.video.request': {
    description: '用一句话生成视频脚本、分镜或通过平台自有中转站渲染成片；返回结果区分计划请求与 provider 实际执行。',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, output: { type: 'string', enum: ['script', 'storyboard', 'rendering'] }, context_json: { type: 'string' } }, required: ['prompt', 'output', 'context_json'], additionalProperties: false },
  },
  'multimodal.video.get': {
    description: '查询排队中的视频 provider job；未完成时明确返回排队状态，不伪造成片。',
    inputSchema: { type: 'object', properties: { provider_job_id: { type: 'string' } }, required: ['provider_job_id'], additionalProperties: false },
  },
}

function jsonRpc(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function jsonRpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }
}

function merchantContextUiHtml() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>大麦商家上下文</title><style>body{font:14px system-ui;color:#202124;margin:0;padding:14px;background:#fff}header{font-weight:650;margin-bottom:10px}.bar{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:8px;border:1px solid #ddd;border-radius:10px;background:#fafafa}.step{padding:5px 8px;border-radius:7px;background:#f0f2f5}.arrow{color:#777}.status{margin-top:10px;color:#666;font-size:12px}.batch{margin-top:12px;display:grid;gap:7px}.action{padding:8px 10px;border:1px solid #cfd6e4;border-radius:8px;background:#fff;text-align:left}.action[disabled]{color:#888;background:#f7f7f7}</style><header>大麦商家工作台</header><div class="bar"><span class="step">工作区</span><span class="arrow">›</span><span class="step">品：待选择</span><span class="arrow">›</span><span class="step">平台：待选择</span><span class="arrow">›</span><span class="step">店铺：待选择</span></div><div class="status">上下文由工具结果填充；切换品会清空平台、店铺和商品选择。演示数据必须标注为演示。</div><div class="batch"><button class="action" disabled>批量生成商品详情（先多选商品）</button><button class="action" disabled>批量发布（需逐项审核批准）</button></div></html>`
}

function actionLink(method, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined
  const field = method === 'platform.connect' ? 'authorizationUrl' : method === 'billing.recharge.create' ? 'paymentUrl' : undefined
  if (!field || typeof result[field] !== 'string' || !result[field].trim()) return undefined
  try {
    const url = new URL(result[field])
    const localFixture = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
    const paymentDeepLink = field === 'paymentUrl' && ['weixin:', 'alipays:'].includes(url.protocol)
    if (url.protocol !== 'https:' && !localFixture && !paymentDeepLink) return undefined
    return {
      type: 'resource_link',
      name: field === 'authorizationUrl' ? 'platform-authorization' : 'payment-checkout',
      title: field === 'authorizationUrl' ? '立即授权店铺' : '打开充值支付页',
      uri: url.toString(),
      description: field === 'authorizationUrl' ? '官方平台授权入口；插件不会接触店铺密码。' : '支付完成后请回到 Codex 查询订单状态；待支付不等于已到账。',
      annotations: { audience: ['user'] },
    }
  } catch { return undefined }
}

function actionCards(method, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const cards = Array.isArray(result.action_cards) ? result.action_cards.map((card, index) => ({
    ...card,
    id: card.id ?? `${method.replaceAll('.', '-')}-${index + 1}`,
    type: card.type ?? (card.method === 'billing.recharge.create' ? 'recharge' : card.method === 'subscription.change' ? 'upgrade' : 'view'),
    label: card.label ?? card.method ?? '查看下一步',
    tool: card.tool ?? card.method,
    arguments: card.arguments && typeof card.arguments === 'object' && !Array.isArray(card.arguments) ? card.arguments : {},
    required_inputs: Array.isArray(card.required_inputs) ? card.required_inputs : [],
    enabled: card.enabled ?? true,
    reason: card.reason ?? card.description ?? '',
    requires_confirmation: card.requires_confirmation ?? card.confirmation === 'interactive_confirmation',
  })) : []
  if (method === 'billing.status' && result.store_capacity && cards.length === 0) {
    for (const [index, label] of (Array.isArray(result.store_capacity.upgrade_actions) ? result.store_capacity.upgrade_actions : []).entries()) {
      cards.push({
        id: `store-capacity-${index + 1}`,
        type: index === 0 ? 'upgrade' : 'store_addon',
        label,
        tool: index === 0 ? 'subscription.change' : 'ops.commercial.addons.list',
        arguments: {},
        required_inputs: index === 0 ? ['to_plan_code', 'billing_cycle', 'reason', 'idempotency_key'] : [],
        enabled: true,
        reason: '当前店铺额度不足，请先增加可用店铺数。',
        requires_confirmation: true,
      })
    }
  }
  if (method === 'billing.status' && cards.every(card => card.type !== 'recharge')) {
    const nextActions = Array.isArray(result.next_actions) ? result.next_actions : []
    if (nextActions.some(action => typeof action === 'string' && action.includes('充值'))) {
      cards.push({ id: 'wallet-recharge', type: 'recharge', label: '创建充值订单', tool: 'billing.recharge.create', arguments: {}, required_inputs: ['channel', 'amount_cny'], enabled: true, reason: '钱包余额不足，请先创建充值订单。', requires_confirmation: true })
    }
  }
  return cards.length ? { ...result, action_cards: cards } : result
}

function merchantContextMetadata(result) {
  const businessUnits = Array.isArray(result?.business_units)
    ? result.business_units
    : Array.isArray(result?.brands) ? result.brands : []
  const stores = Array.isArray(result?.storeDirectory)
    ? result.storeDirectory
    : Array.isArray(result?.stores) ? result.stores : []
  const simulated = result?.execution?.simulated === true || result?.simulated === true || result?.mode === 'fixture'
  return {
    schema_version: '1',
    surface: 'merchant_codex_app',
    data_status: simulated ? 'demo' : 'real_or_server_reported',
    data_status_label: simulated ? '演示数据' : '服务端数据',
    context_bar: {
      order: ['workspace', 'business_unit', 'platform', 'store'],
      labels: { workspace: '工作区', business_unit: '品', platform: '平台', store: '店铺' },
      selection: {
        workspace: { state: result?.workspace?.id || result?.workspace_id ? 'selected' : 'unknown', value: result?.workspace?.id ?? result?.workspace_id ?? null },
        business_unit: { state: businessUnits.length ? 'available' : 'not_provided', value: null, options: businessUnits },
        platform: { state: result?.platform ? 'selected' : 'selectable', value: result?.platform ?? null },
        store: { state: result?.account_id || result?.accountId ? 'selected' : stores.length ? 'selectable' : 'unknown', value: result?.account_id ?? result?.accountId ?? null, options: stores },
      },
      reset_on_change: {
        business_unit: ['platform', 'account_id', 'product_id', 'selected_product_ids'],
        platform: ['account_id', 'product_id', 'selected_product_ids'],
        account_id: ['product_id', 'selected_product_ids'],
      },
      unresolved: businessUnits.length ? [] : ['品目录尚未由当前 API 提供；不能把品牌或店铺自动当作品'],
    },
  }
}

function merchantUiMetadata(method, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || !MERCHANT_CONTEXT_METHODS.has(method)) return result
  const ui = merchantContextMetadata(result)
  if (method === 'catalog.search') {
    const products = Array.isArray(result.products) ? result.products : Array.isArray(result.items) ? result.items : []
    ui.list = {
      kind: 'products',
      selection: 'multi',
      selection_key: 'product_id',
      empty_state: products.length ? null : '当前范围暂无商品；请先同步或导入商品。',
      batch_actions: [
        { id: 'batch-generate', label: '批量生成详情', tool: 'task.group.create', enabled: false, requires_selection: true, selection_key: 'product_id' },
        { id: 'batch-publish', label: '批量发布', tool: 'publish.batch.prepare', enabled: false, requires_selection: true, selection_key: 'task_id', reason: '需要先完成内容审核并批准。' },
      ],
    }
  }
  if (method === 'merchant.start') {
    ui.batch_discovery = [
      { id: 'batch-generate', label: '批量生成商品详情', tool: 'catalog.search', next_tool: 'task.group.create', enabled: true, requires_selection: true },
      { id: 'batch-publish', label: '批量发布已批准商品', tool: 'publish.batch.prepare', enabled: false, requires_selection: true, reason: '先选择商品并完成逐项审核、批准。' },
    ]
  }
  return { ...result, ui }
}

function toolUiMetadata(name) {
  if (!MERCHANT_CONTEXT_METHODS.has(name)) return undefined
  return {
    ui: { resourceUri: MERCHANT_CONTEXT_UI_URI, prefersBorder: true },
    'openai/outputTemplate': MERCHANT_CONTEXT_UI_URI,
    'openai/toolInvocation/invoking': name === 'catalog.search' ? '正在加载商品列表…' : '正在加载工作区上下文…',
    'openai/toolInvocation/invoked': name === 'catalog.search' ? '商品列表已更新' : '上下文已更新',
  }
}

function toolContent(method, result) {
  result = actionCards(method, result)
  if (method === 'content.export') return materializeExportArtifact(result).content
  const hasImages = (method.startsWith('catalog.image.') || method === 'creative.preview' || method === 'multimodal.image.edit') && Array.isArray(result?.images)
  // Keep the human-readable text small. Sending the full base64 payload both in
  // text and as image blocks makes Codex render the tool result as an oversized
  // text response and can hide the actual image attachments.
  const imageFiles = hasImages ? materializeImageFiles(result.images) : []
  const textResult = hasImages
    ? { ...result, images: result.images.map((image, index) => typeof image === 'string' ? `[image attachment ${index + 1}]` : image), ...(imageFiles.length ? { image_files: imageFiles, image_markdown: imageFiles.map((file, index) => `![商品主图${index + 1}](${file})`).join('\n') } : {}) }
    : result
  const content = [{ type: 'text', text: JSON.stringify(textResult) }]
  const link = actionLink(method, result)
  if (link) content.push(link)
  if (!hasImages) return content
  for (const image of result.images) {
    if (typeof image !== 'string') continue
    const match = image.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/iu)
    if (match) content.push({ type: 'image', data: match[2], mimeType: match[1] })
  }
  return content
}

function exportArtifactResult(result) {
  const materialized = materializeExportArtifact(result)
  return { content: materialized.content, structuredContent: materialized.structuredContent }
}

function artifactDirectory() {
  if (sessionArtifactDirectory) return sessionArtifactDirectory
  const configured = process.env.MERCHANT_ARTIFACT_DIR?.trim()
  const hasConfiguredRoot = configured && !/^\$\{[^}]+\}$/u.test(configured)
  if (process.env.NODE_ENV === 'production' && !hasConfiguredRoot) throw new Error('生产环境必须配置 MERCHANT_ARTIFACT_DIR')
  if (hasConfiguredRoot && !isAbsolute(configured)) throw new Error('MERCHANT_ARTIFACT_DIR 必须是绝对路径')
  const root = resolve(hasConfiguredRoot ? configured : join(tmpdir(), 'merchant-marketing-codex-artifacts'))
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const info = lstatSync(root)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('MERCHANT_ARTIFACT_DIR 必须是普通目录，不能是符号链接')
  if (!hasConfiguredRoot) chmodSync(root, 0o700)
  sessionArtifactDirectory = mkdtempSync(join(root, 'session-'))
  chmodSync(sessionArtifactDirectory, 0o700)
  return sessionArtifactDirectory
}

function materializeExportArtifact(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('content.export 返回格式无效')
  const contentType = typeof result.contentType === 'string' ? result.contentType.split(';')[0].trim().toLowerCase() : ''
  const extension = contentType === 'application/zip' ? '.zip' : contentType === 'text/markdown' ? '.md' : contentType === 'application/json' ? '.json' : ''
  if (!extension) throw new Error('content.export 返回了不支持的文件类型')
  let bytes
  if (contentType === 'application/zip') {
    const encoded = typeof result.binary_base64 === 'string' ? result.binary_base64 : ''
    if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) throw new Error('content.export ZIP 数据无效')
    if (encoded.length > Math.ceil(MAX_EXPORT_ARTIFACT_BYTES / 3) * 4 + 4) throw new Error('content.export 文件超过 25MB 限制')
    bytes = Buffer.from(encoded, 'base64')
  } else {
    if (typeof result.body !== 'string') throw new Error('content.export 文本数据无效')
    bytes = Buffer.from(result.body, 'utf8')
  }
  if (!bytes.length || bytes.length > MAX_EXPORT_ARTIFACT_BYTES) throw new Error('content.export 文件为空或超过 25MB 限制')
  if (contentType === 'application/zip' && !(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)) throw new Error('content.export ZIP 文件签名无效')
  if (contentType === 'application/json') {
    try { JSON.parse(bytes.toString('utf8')) } catch { throw new Error('content.export JSON 文件无效') }
  }
  if (sessionArtifactFiles >= MAX_SESSION_ARTIFACT_FILES || sessionArtifactBytes + bytes.length > MAX_SESSION_ARTIFACT_BYTES) throw new Error('content.export 当前会话文件配额已用尽')
  const directory = artifactDirectory()
  const fileName = `merchant-content-export-${randomUUID()}${extension}`
  const file = join(directory, fileName)
  writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' })
  sessionArtifactFiles += 1
  sessionArtifactBytes += bytes.length
  const uri = pathToFileURL(file).href
  const structuredContent = {
    status: 'ready',
    file: { name: fileName, contentType, sizeBytes: bytes.length },
    generatedOnDemand: true,
    includesHistoricalImages: false,
  }
  return {
    structuredContent,
    content: [
      { type: 'text', text: JSON.stringify(structuredContent) },
      { type: 'resource_link', name: fileName, title: '内容导出', uri, mimeType: contentType, size: bytes.length, description: 'Codex 本地生成的按需内容导出；不代表已批准或已发布。', annotations: { audience: ['user'] } },
    ],
  }
}

async function responseJsonWithLimit(response) {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > MAX_REMOTE_RESPONSE_BYTES) throw new Error('MCP gateway response exceeds the 36MB limit')
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_REMOTE_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new Error('MCP gateway response exceeds the 36MB limit')
    }
    chunks.push(Buffer.from(value))
  }
  try { return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) } catch { return null }
}

function materializeImageFiles(images) {
  const root = process.env.MERCHANT_ARTIFACT_DIR?.trim()
  const directory = resolve(root && !/^\$\{[^}]+\}$/u.test(root) ? root : join(process.cwd(), 'artifacts', 'codex-output'))
  try { mkdirSync(directory, { recursive: true }) } catch { return [] }
  const files = []
  for (const [index, image] of images.entries()) {
    if (typeof image !== 'string') continue
    const match = image.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/iu)
    if (!match) continue
    const extension = match[1].toLowerCase() === 'image/jpeg' ? '.jpg' : `.${match[1].split('/')[1].replace(/\+xml$/u, '')}`
    const file = join(directory, `merchant-image-${Date.now()}-${index + 1}${extension}`)
    try {
      writeFileSync(file, Buffer.from(match[2], 'base64'), { mode: 0o600 })
      files.push(file)
    } catch { /* image content block remains available */ }
  }
  return files
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function rechargeUiHtml() {
  return readFileSync(new URL('../ui/recharge.html', import.meta.url), 'utf8')
}

function configuredEnv(name) {
  const value = process.env[name]?.trim()
  return value && !/^\$\{[^}]+\}$/u.test(value) ? value : ''
}

function workspaceBindingPath() {
  const codexHome = configuredEnv('CODEX_HOME') || join(homedir(), '.codex')
  return join(codexHome, 'merchant-marketing', 'workspace-binding.json')
}

function loadWorkspaceBinding() {
  if (bootstrappedWorkspaceId) return bootstrappedWorkspaceId
  try {
    const binding = JSON.parse(readFileSync(workspaceBindingPath(), 'utf8'))
    if (typeof binding.workspace_id === 'string' && /^ws_[a-z0-9_]+$/u.test(binding.workspace_id)) bootstrappedWorkspaceId = binding.workspace_id
  } catch { /* first run or unreadable binding: bootstrap will explain the next step */ }
  return bootstrappedWorkspaceId
}

function saveWorkspaceBinding(workspaceIdValue) {
  try {
    const path = workspaceBindingPath()
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(path, JSON.stringify({ schema_version: '1', workspace_id: workspaceIdValue, saved_at: new Date().toISOString() }) + '\n', { mode: 0o600 })
    chmodSync(path, 0o600)
  } catch { /* durable binding is best effort; API still returns the binding for recovery */ }
}

function allowsLocalFixtureFallback() {
  return configuredEnv('MERCHANT_ALLOW_FIXTURE_FALLBACK').toLowerCase() === 'true'
}

function allowsWriteTools() {
  return configuredEnv('MERCHANT_MCP_WRITE_ENABLED').toLowerCase() === 'true' || interactiveWriteUntil > Date.now()
}

function confirmInteractiveWrites(args) {
  if (args.confirmation !== 'I_CONFIRM_INTERACTIVE_WRITES') {
    const error = new Error('必须在当前交互会话明确确认写操作')
    error.code = 'INTERACTIVE_CONFIRMATION_REQUIRED'
    throw error
  }
  interactiveWriteUntil = Date.now() + INTERACTIVE_WRITE_TTL_MS
  return { enabled: true, expires_at: new Date(interactiveWriteUntil).toISOString(), scope: 'current_plugin_process', automation: 'read_only' }
}

function baseUrl() {
  const value = configuredEnv('MERCHANT_MCP_BASE_URL') || (allowsLocalFixtureFallback() ? 'http://127.0.0.1:8790' : '')
  if (!value) throw new Error('MERCHANT_MCP_BASE_URL is required; refusing to use the local fixture fallback unless MERCHANT_ALLOW_FIXTURE_FALLBACK=true')
  const parsed = new URL(value)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('MERCHANT_MCP_BASE_URL must use http or https')
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') throw new Error('MERCHANT_MCP_BASE_URL must use https in production')
  return `${value.replace(/\/+$/, '')}/mcp`
}

function workspaceId() {
  const value = configuredEnv('MERCHANT_WORKSPACE_ID') || loadWorkspaceBinding() || (allowsLocalFixtureFallback() ? 'ws_demo' : '')
  if (!value) throw new Error('MERCHANT_WORKSPACE_ID is required; refusing to use ws_demo unless MERCHANT_ALLOW_FIXTURE_FALLBACK=true')
  return value
}

function idempotencyKey(method, params) {
  const digest = createHash('sha256')
    .update(JSON.stringify({ workspaceId: workspaceId(), method, params }))
    .digest('hex')
  return `mcp-${digest}`
}

function prepareToolArguments(method, params) {
  if (method !== 'asset.upload') return params
  const filePath = typeof params.file_path === 'string' ? params.file_path.trim() : ''
  const inlineContent = typeof params.content_base64 === 'string' ? params.content_base64.trim() : ''
  if (filePath && inlineContent) throw new Error('asset.upload 只能提供 file_path 或 content_base64 其中一个')
  if (!filePath) return params
  if (!isAbsolute(filePath)) throw new Error('asset.upload file_path 必须是绝对路径')
  const info = lstatSync(filePath)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('asset.upload file_path 必须指向普通文件，不能是目录或符号链接')
  if (info.size > MAX_LOCAL_UPLOAD_BYTES) throw new Error('asset.upload 单文件不能超过 50MB')
  const bytes = readFileSync(filePath)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (typeof params.sha256 === 'string' && params.sha256.trim() && params.sha256.trim().toLowerCase() !== digest) {
    throw new Error('asset.upload 文件 SHA-256 与提供值不一致')
  }
  const prepared = { ...params, content_base64: bytes.toString('base64'), sha256: digest }
  delete prepared.file_path
  return prepared
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function callRemote(method, params) {
  // A new Codex conversation must not force a merchant to understand
  // workspace IDs or environment variables. Bootstrap is still explicit at
  // the API boundary, but the bridge performs it once before the first
  // merchant-facing entry point. Production never falls back to ws_demo.
  if (method === 'merchant.start' && !configuredEnv('MERCHANT_WORKSPACE_ID') && !loadWorkspaceBinding() && !allowsLocalFixtureFallback()) {
    await callRemote('workspace.bootstrap', { display_name: '大麦商家工作区' })
  }
  const scopedWorkspaceId = method === 'workspace.bootstrap' ? '' : workspaceId()
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    ...(scopedWorkspaceId ? { 'x-workspace-id': scopedWorkspaceId } : {}),
  }
  if (method === 'workspace.bootstrap') headers['x-workspace-bootstrap'] = 'true'
  const actorId = process.env.MERCHANT_ACTOR_ID?.trim()
  const role = process.env.MERCHANT_MCP_ROLE?.trim()
  if (actorId && !/^\$\{[^}]+\}$/u.test(actorId)) headers['x-actor-id'] = actorId
  if (role && !/^\$\{[^}]+\}$/u.test(role)) headers['x-role'] = role
  const token = process.env.MERCHANT_MCP_TOKEN?.trim()
  if (token && !/^\$\{[^}]+\}$/u.test(token)) headers.authorization = `Bearer ${token}`
  const ruleApprovalToken = process.env.MERCHANT_RULE_APPROVAL_TOKEN?.trim()
  if ((method === 'rule.publish' || method === 'rule.status') && ruleApprovalToken && !/^\$\{[^}]+\}$/u.test(ruleApprovalToken)) headers['x-rule-approval-token'] = ruleApprovalToken
  if (method === 'publish.confirm' || method === 'content.generate' || method === 'content.visual.select') {
    headers['idempotency-key'] = typeof params.idempotency_key === 'string' && params.idempotency_key.trim()
      ? params.idempotency_key.trim()
      : idempotencyKey(method, params)
  }

  const timeoutMs = Number(process.env.MERCHANT_MCP_TIMEOUT_MS ?? 30000)
  const maxAttempts = Math.max(1, Number(process.env.MERCHANT_MCP_RETRY_ATTEMPTS ?? 5))
  const retryDelayMs = Math.max(50, Number(process.env.MERCHANT_MCP_RETRY_DELAY_MS ?? 200))
  const deadline = Date.now() + timeoutMs
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) throw new Error('MCP gateway request timed out while waiting for the local API')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), remainingMs)
      try {
        const response = await fetch(baseUrl(), {
          method: 'POST',
          headers,
          body: JSON.stringify({ jsonrpc: '2.0', id: `${Date.now()}-${Math.random()}`, method, params: { ...params, ...(scopedWorkspaceId ? { workspace_id: scopedWorkspaceId } : {}) } }),
          signal: controller.signal,
        })
        const payload = await responseJsonWithLimit(response)
        const retrySafe = READ_ONLY_METHODS.has(method) || headers['idempotency-key'] !== undefined
        const transient = response.status === 429 || ((response.status === 502 || response.status === 503 || response.status === 504) && retrySafe)
        if ((!response.ok || !payload || payload.error) && (!transient || attempt === maxAttempts)) {
          const error = payload?.error ?? { code: `HTTP_${response.status}`, message: `MCP gateway returned HTTP ${response.status}` }
          throw Object.assign(new Error(error.message ?? 'MCP gateway error'), { code: error.code, details: error.details })
        }
        if (!response.ok || !payload || payload.error) {
          const retryAfter = response.status === 429 ? Number(response.headers.get('retry-after') ?? '') : Number.NaN
          const retryAfterMs = Number.isFinite(retryAfter) ? Math.max(50, Math.ceil(retryAfter * 1_000)) : 0
          const backoffMs = retryAfterMs > 0 ? retryAfterMs : retryDelayMs * (2 ** (attempt - 1))
          await wait(Math.min(backoffMs, Math.max(50, deadline - Date.now())))
          continue
        }
        // The current API intentionally wraps its JSON-RPC result in the common
        // application envelope. Keep this adapter boundary in the plugin until
        // the API exposes native MCP transport responses.
        const result = payload.data?.result
        if (result === undefined) throw new Error('MCP gateway response is missing data.result')
        if (method === 'workspace.bootstrap' && result && typeof result === 'object' && typeof result.workspaceId === 'string' && result.workspaceId.trim()) {
          // Keep the first-run flow seamless within this plugin process. The
          // returned binding remains the durable cross-session contract.
          bootstrappedWorkspaceId = result.workspaceId.trim()
          saveWorkspaceBinding(bootstrappedWorkspaceId)
        }
        return result
      } catch (error) {
        const retryableNetworkError = error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')
        if (!retryableNetworkError || attempt === maxAttempts || Date.now() >= deadline) throw error
        await wait(Math.min(retryDelayMs * (2 ** (attempt - 1)), Math.max(50, deadline - Date.now())))
      } finally {
        clearTimeout(timer)
      }
    }
  } finally {
    // Each attempt owns its timeout; this boundary intentionally has no global timer.
  }
}

async function handle(request) {
  const id = request.id ?? null
  if (request.jsonrpc !== '2.0') return jsonRpcError(id, -32600, 'Invalid JSON-RPC request')
  if (request.method === 'notifications/initialized') return null
  if (request.method === 'ping') return jsonRpc(id, {})
  if (request.method === 'initialize') {
    return jsonRpc(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: 'merchant-marketing', version: '0.1.0' },
      instructions: '先调用 merchant.start；需要诊断时再调用 workspace.health。发布前必须人工确认并调用 publish.prepare。',
    })
  }
  if (request.method === 'resources/list') {
    return jsonRpc(id, { resources: [
      { uri: RECHARGE_UI_URI, name: '大麦充值', title: '大麦钱包充值', description: '显示钱包余额、额度不足提醒、充值渠道和订单状态。', mimeType: 'text/html;profile=mcp-app' },
      { uri: MERCHANT_CONTEXT_UI_URI, name: '大麦上下文', title: '大麦品/平台/店铺上下文', description: '显示工作区→品→平台→店铺固定上下文和批量商品入口。', mimeType: 'text/html;profile=mcp-app' },
    ] })
  }
  if (request.method === 'resources/read') {
    if (request.params?.uri === MERCHANT_CONTEXT_UI_URI) return jsonRpc(id, { contents: [{ uri: MERCHANT_CONTEXT_UI_URI, mimeType: 'text/html;profile=mcp-app', text: merchantContextUiHtml(), _meta: { ui: { prefersBorder: true } } }] })
    if (request.params?.uri !== RECHARGE_UI_URI) return jsonRpcError(id, -32602, `Unknown resource: ${String(request.params?.uri)}`)
    return jsonRpc(id, { contents: [{ uri: RECHARGE_UI_URI, mimeType: 'text/html;profile=mcp-app', text: rechargeUiHtml(), _meta: { ui: { prefersBorder: true } } }] })
  }
  if (request.method === 'tools/list') {
    return jsonRpc(id, { tools: Object.entries(METHODS).filter(([name]) => isMerchantTool(name)).map(([name, value]) => ({
      name,
      ...value,
      ...(RECHARGE_UI_METHODS.has(name) || MERCHANT_CONTEXT_METHODS.has(name) ? { _meta: { ...(RECHARGE_UI_METHODS.has(name) ? { ui: { resourceUri: RECHARGE_UI_URI }, 'openai/outputTemplate': RECHARGE_UI_URI, 'openai/toolInvocation/invoking': name.startsWith('billing.') ? '正在读取钱包…' : '正在检查余额与额度…', 'openai/toolInvocation/invoked': name.startsWith('billing.') ? '钱包已更新' : '余额检查完成' } : {}), ...(toolUiMetadata(name) ?? {}) } } : {}),
      ...(READ_ONLY_METHODS.has(name) ? { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } } : {}),
      ...(name === 'content.visual.select' ? { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } } : {}),
      ...(name === 'content.export' ? { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } } : {}),
    })) })
  }
  if (request.method === 'tools/call') {
    const name = request.params?.name
    const args = request.params?.arguments
    if (typeof name !== 'string' || !isMerchantTool(name) || !METHODS[name]) return jsonRpcError(id, -32602, `Unknown tool: ${String(name)}`)
    if (!args || typeof args !== 'object' || Array.isArray(args)) return jsonRpcError(id, -32602, 'Tool arguments must be an object')
    if (name === 'billing.recharge.get' && Object.prototype.hasOwnProperty.call(args, 'confirm_test_payment')) {
      return jsonRpcError(id, -32602, 'Unsupported tool argument: confirm_test_payment')
    }
    if (name === 'workspace.interactive.confirm') {
      try {
        const result = confirmInteractiveWrites(args)
        return jsonRpc(id, { content: toolContent(name, result), structuredContent: result, isError: false })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'interactive confirmation failed'
        const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'INTERACTIVE_CONFIRMATION_REQUIRED'
        return jsonRpc(id, { content: [{ type: 'text', text: JSON.stringify({ code, message }) }], structuredContent: { code, message }, isError: true })
      }
    }
    if (!SAFE_WITHOUT_INTERACTIVE_WRITE.has(name) && !allowsWriteTools()) {
      const structuredContent = {
        code: 'INTERACTIVE_WRITE_DISABLED',
        message: '当前操作需要商家明确确认。请先确认后继续；如果套餐额度或钱包余额不足，我会提示充值。',
        technical_hint: 'interactive_write_session_required',
      }
      return jsonRpc(id, { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent, isError: true })
    }
    try {
      const result = await callRemote(name, prepareToolArguments(name, args))
      if (name === 'content.export') {
        const artifact = exportArtifactResult(result)
        return jsonRpc(id, { ...artifact, isError: false })
      }
      const normalizedResult = merchantUiMetadata(name, actionCards(name, result))
      return jsonRpc(id, { content: toolContent(name, normalizedResult), structuredContent: normalizedResult, isError: false })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'MCP gateway request failed'
      const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'MCP_GATEWAY_ERROR'
      const details = error && typeof error === 'object' && error.details && typeof error.details === 'object' ? error.details : undefined
      const rechargeRequired = code === 'RECHARGE_REQUIRED' || code === 'BILLING_INSUFFICIENT_BALANCE'
      const structuredContent = { code, message, ...(details ? { details } : {}), ...(rechargeRequired ? { show_recharge: true, recharge_reason: '余额或套餐额度不足', recommended_amounts_cny: ['50.00', '100.00', '300.00'], recharge_channels: ['alipay', 'wechat'] } : {}) }
      return jsonRpc(id, { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent, ...(RECHARGE_UI_METHODS.has(name) ? { _meta: { ui: { resourceUri: RECHARGE_UI_URI } } } : {}), isError: true })
    }
  }
  return jsonRpcError(id, -32601, `Method not found: ${String(request.method)}`)
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
let requestQueue = Promise.resolve()
input.on('line', line => {
  if (!line.trim()) return
  let request
  try { request = JSON.parse(line) } catch { write(jsonRpcError(null, -32700, 'Parse error')); return }
  requestQueue = requestQueue.then(() => handle(request))
  requestQueue
    .then(response => { if (response) write(response) })
    .catch(error => write(jsonRpcError(request.id ?? null, -32603, error instanceof Error ? error.message : 'Internal error')))
})
