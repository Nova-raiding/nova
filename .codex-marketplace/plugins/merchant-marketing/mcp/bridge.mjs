#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

const PROTOCOL_VERSION = '2025-06-18'
const PLUGIN_VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('../.codex-plugin/plugin.json', import.meta.url), 'utf8')).version }
  catch { return '' }
})()
const RECHARGE_UI_URI = 'ui://merchant-marketing/recharge-v1.html'
const CREATIVE_CHOICE_UI_URI = 'ui://merchant-marketing/creative-choice-v1.html'
const CONTENT_DIFF_UI_URI = 'ui://merchant-marketing/content-diff-v1.html'
const PUBLISH_CONFIRM_UI_URI = 'ui://merchant-marketing/publish-confirm-v1.html'
const IMAGE_EDIT_UI_URI = 'ui://merchant-marketing/image-local-edit-v1.html'
const IMAGE_CANDIDATE_CHOICE_UI_URI = 'ui://merchant-marketing/image-candidate-choice-v15.html'
// These methods may contribute structured context for the model's native
// conversation without necessarily rendering an embedded component.
const MERCHANT_CONTEXT_METADATA_METHODS = new Set([
  'merchant.start', 'workspace.health', 'catalog.search', 'catalog.import.batch',
  'task.group.create', 'publish.batch.prepare', 'publish.batch.get',
])
// Only results that materially benefit from selection, review, or confirmation
// should opt into the context component. Routine onboarding, health checks, and
// automatic scan progress stay in the host's native conversation surface.
const MERCHANT_CONTEXT_COMPONENT_METHODS = new Set([
  'creative.directions',
  'content.diff',
  'publish.prepare',
  'publish.batch.prepare',
])
const TASK_UI_METHODS = new Map([
  ['creative.directions', CREATIVE_CHOICE_UI_URI],
  ['content.diff', CONTENT_DIFF_UI_URI],
  ['publish.prepare', PUBLISH_CONFIRM_UI_URI],
  ['publish.batch.prepare', PUBLISH_CONFIRM_UI_URI],
])
const RECHARGE_UI_METHODS = new Set()
const IMAGE_EDIT_UI_METHODS = new Set()
const RELAY_EVIDENCE_METHODS = new Set(['content.generate', 'catalog.image.generate', 'multimodal.generate', 'multimodal.video.request', 'multimodal.image.edit'])
const MAX_LOCAL_UPLOAD_BYTES = 50 * 1024 * 1024
const MAX_EXPORT_ARTIFACT_BYTES = 25 * 1024 * 1024
const MAX_REMOTE_RESPONSE_BYTES = 36 * 1024 * 1024
const MAX_SESSION_ARTIFACT_BYTES = 250 * 1024 * 1024
const MAX_SESSION_ARTIFACT_FILES = 100
const INTERACTIVE_WRITE_TTL_MS = 15 * 60 * 1000
const ASSET_SCAN_POLL_TIMEOUT_MS = Math.min(30_000, Math.max(100, Number(process.env.MERCHANT_ASSET_SCAN_POLL_TIMEOUT_MS ?? 12_000)))
const ASSET_SCAN_POLL_INTERVAL_MS = Math.min(2_000, Math.max(25, Number(process.env.MERCHANT_ASSET_SCAN_POLL_INTERVAL_MS ?? 400)))
let sessionArtifactDirectory
let sessionArtifactBytes = 0
let sessionArtifactFiles = 0
let interactiveWriteUntil = 0
let bootstrappedWorkspaceId = ''
const READ_ONLY_METHODS = new Set([
  'merchant.start',
  'merchant.first_value',
  'brand-unit.list', 'brand-unit.listing.list', 'canonical.product.consistency', 'campaign.batch.list', 'campaign.batch.get',
  'workspace.health', 'catalog.search', 'catalog.categories', 'catalog.image.get',
  'workspace.metrics', 'workspace.commercial.get', 'workspace.usage.get', 'ops.audit.list', 'ops.audit.export', 'ops.data.delete.list', 'ops.members.list', 'ops.session', 'ops.workspaces.list',
  'ops.support.tickets.list', 'ops.support.ticket.get', 'ops.support.crm.export',
  'ops.incidents.list', 'ops.incident.get', 'ops.incident.timeline',
  'ops.feature-flags.list', 'ops.feature-flag.events', 'ops.feature-flag.evaluate',
  'ops.finance.search', 'ops.finance.detail', 'ops.finance.export',
  'ops.users.list', 'ops.users.export', 'ops.user.detail', 'ops.commercial.offers.list', 'ops.commercial.addons.list', 'ops.commercial.coupons.list', 'ops.commercial.export', 'ops.commercial.rollouts.list', 'ops.growth.funnel', 'ops.alerts.list', 'subscription.get', 'subscription.orders.list', 'billing.reconciliation', 'platform.settings.get', 'platform.media.spec.list', 'platform.media.spec.get', 'platform.mapping.preflight', 'delivery.bundle.verify',
  'billing.status', 'billing.model-usage.statement', 'billing.recharge.get', 'billing.recharge.list', 'billing.transactions', 'billing.export', 'catalog.sync.get',
  'rule.list', 'rule.sync.status', 'rule.history', 'rule.audit', 'asset.list', 'brand.get', 'brand.extract', 'brand.tone.preview',
  'deliverable.list', 'task.history', 'task.resume', 'task.timeline', 'task.understand', 'feedback.list', 'generation.get', 'content.review',
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
  'asset.scan',
  'content.codex.prepare',
  'content.codex.commit',
])
const isMerchantTool = name => !name.startsWith('ops.') && !MERCHANT_HIDDEN_METHODS.has(name)
const boundedString = (maxLength, minLength = 1, description) => ({ type: 'string', minLength, maxLength, ...(description ? { description } : {}) })
const positiveIntegerString = { type: 'string', pattern: '^[1-9][0-9]*$', maxLength: 10 }
const pageLimit100 = { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$', maxLength: 3 }
const pageLimit200 = { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$', maxLength: 3 }
const exportLimit5000 = { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]{1,2}|[1-4][0-9]{3}|5000)$', maxLength: 4 }
const idempotencyKeyProperty = { type: 'string', minLength: 8, maxLength: 200, pattern: '^[A-Za-z0-9._:-]+$' }
const sha256HashProperty = { type: 'string', pattern: '^[a-f0-9]{64}$', minLength: 64, maxLength: 64 }
const booleanString = { type: 'string', enum: ['true', 'false'] }
const jsonObject = description => ({ type: 'string', contentMediaType: 'application/json', jsonShape: 'object', description })
const jsonArray = description => ({ type: 'string', contentMediaType: 'application/json', jsonShape: 'array', description })
const reasonProperty = boundedString(1000, 3, '当前交互写操作的可审计原因。')
// These actions are explicitly part of first-run activation or read-only
// catalog synchronization. They may create a pending order or a sync handle,
// but do not consume wallet balance or publish content. Generation, editing,
// approvals, and publish confirmation remain behind the interactive-write gate.
const SAFE_WITHOUT_INTERACTIVE_WRITE = new Set([
  ...READ_ONLY_METHODS,
  'content.export', 'catalog.image.review', 'catalog.image.select', 'workspace.bootstrap',
  'workspace.interactive.confirm',
  'platform.store.list', 'platform.connect', 'billing.recharge.create', 'catalog.sync', 'catalog.sync.start',
])
const ALWAYS_INTERACTIVE_WRITE_METHODS = new Set([
  'platform.media.spec.create', 'platform.media.spec.update', 'platform.media.spec.approve', 'platform.media.spec.expire',
  'campaign.batch.pause', 'campaign.batch.resume', 'campaign.batch.retry_failed',
])
const DESTRUCTIVE_WRITE_METHODS = new Set([
  'platform.revoke', 'workspace.deactivate', 'workspace.data.delete.request', 'ops.data.delete.cancel', 'ops.data.delete.approve',
  'catalog.product.disable', 'automation.pause', 'publish.confirm', 'publish.batch.confirm',
])
const METHODS = {
  'merchant.start': {
    description: '开始使用大麦；返回当前步骤、店铺/商品摘要和下一句可以直接照着说的话。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        requested_platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'], description: '用户在当前消息中明确指定的平台' },
        requested_goal: { type: 'string', description: '用户在当前消息中明确提出的任务目标' },
        attachment_count: { type: 'integer', minimum: 0, description: '当前消息携带的附件数量' },
        idempotency_key: { type: 'string', minLength: 8, maxLength: 200, description: '同一开始意图重试时保持稳定；通常由插件自动生成' },
      },
      additionalProperties: false,
    },
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
    description: '将已存在的平台授权店铺绑定到指定品；可传入品当前 revision，避免并发覆盖。',
    inputSchema: { type: 'object', properties: { brand_id: { type: 'string' }, platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, account_id: { type: 'string' }, expected_revision: positiveIntegerString }, required: ['brand_id', 'platform', 'account_id'], additionalProperties: false },
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
  'canonical.product.consistency': {
    description: '只读检查当前工作区 legacy 商品、canonical 商品、平台 listing、批量项和任务的显式关系；不会猜测或修改数据。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'campaign.batch.create': {
    description: '为一个品和最多 50 个跨平台、跨店商品创建可恢复的批量运营计划；不会自动发布。',
    inputSchema: { type: 'object', properties: { brand_id: { type: 'string' }, platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, account_id: { type: 'string' }, product_ids_json: { type: 'string', description: '兼容单店铺模式：1 至 50 个商品 ID 的 JSON 数组' }, targets_json: { type: 'string', description: '多目标模式：每项含 product_id 或 canonical_product_id、platform、account_id，可选 listing_id' }, idempotency_key: { type: 'string', description: '重试同一批量计划时保持不变' } }, required: ['brand_id'], additionalProperties: false },
  },
  'campaign.batch.list': {
    description: '列出当前工作区可访问的批量运营计划摘要；桌面任务中心会让商家选择计划，不要求输入内部编号。只读。',
    inputSchema: { type: 'object', properties: { platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, account_id: { type: 'string' }, limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' } }, additionalProperties: false },
  },
  'campaign.batch.get': {
    description: '刷新并查看批量计划逐商品状态、汇总、阻断项和下一步；只读。',
    inputSchema: { type: 'object', properties: { campaign_id: { type: 'string' } }, required: ['campaign_id'], additionalProperties: false },
  },
  'campaign.batch.generate': {
    description: '启动可恢复的逐商品内容工作流；事实确认后自动续跑到待审核，每项仍需规则审核和人工批准。',
    inputSchema: { type: 'object', properties: { campaign_id: { type: 'string' }, request_text: { type: 'string' }, idempotency_key: { type: 'string' } }, required: ['campaign_id'], additionalProperties: false },
  },
  'campaign.batch.pause': {
    description: '经当前会话交互确认，以 expected_revision 暂停批量计划；不会把在途外部任务伪造成已取消，修订过期或幂等冲突时 fail-closed。',
    inputSchema: { type: 'object', properties: { campaign_id: boundedString(200), expected_revision: positiveIntegerString, idempotency_key: idempotencyKeyProperty, reason: reasonProperty }, required: ['campaign_id', 'expected_revision', 'idempotency_key', 'reason'], additionalProperties: false },
  },
  'campaign.batch.resume': {
    description: '经当前会话交互确认，以 expected_revision 恢复已暂停批量计划；保留全部人工审批门禁，修订过期或幂等冲突时 fail-closed。',
    inputSchema: { type: 'object', properties: { campaign_id: boundedString(200), expected_revision: positiveIntegerString, idempotency_key: idempotencyKeyProperty, reason: reasonProperty }, required: ['campaign_id', 'expected_revision', 'idempotency_key', 'reason'], additionalProperties: false },
  },
  'campaign.batch.retry_failed': {
    description: '经当前会话交互确认，仅重试批量计划中的失败项；不重放成功项且不越过审批门禁，状态不明确或修订过期时 fail-closed。',
    inputSchema: { type: 'object', properties: { campaign_id: boundedString(200), item_ids_json: jsonArray('可选：1 至 50 个不重复 failed campaign item ID 的 JSON 数组；省略则重试全部失败项。'), expected_revision: positiveIntegerString, idempotency_key: idempotencyKeyProperty, reason: reasonProperty }, required: ['campaign_id', 'expected_revision', 'idempotency_key', 'reason'], additionalProperties: false },
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
  'ops.support.tickets.list': { description: '查看一个授权工作区内的有界客服工单队列。只读。', inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'in_progress', 'waiting_customer', 'resolved', 'closed'] }, priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] }, assignee_id: boundedString(256), customer_id: boundedString(256), query: boundedString(200), cursor_json: boundedString(2000), limit: pageLimit100 }, additionalProperties: false } },
  'ops.support.ticket.get': { description: '查看一张客服工单和不可变事件历史。只读。', inputSchema: { type: 'object', properties: { ticket_id: boundedString(36) }, required: ['ticket_id'], additionalProperties: false } },
  'ops.support.ticket.create': { description: '创建带幂等键的客服工单。', inputSchema: { type: 'object', properties: { subject: boundedString(200, 3), description: boundedString(10000), priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] }, customer_id: boundedString(256), customer_name: boundedString(200), customer_email: boundedString(320), related_order_id: boundedString(256), related_task_id: boundedString(256), tags_json: boundedString(2000), idempotency_key: idempotencyKeyProperty }, required: ['subject', 'description', 'priority', 'customer_id', 'customer_name', 'idempotency_key'], additionalProperties: false } },
  'ops.support.ticket.assign': { description: '按 revision 和幂等键分配客服工单。', inputSchema: { type: 'object', properties: { ticket_id: boundedString(36), assignee_id: boundedString(256), expected_revision: positiveIntegerString, idempotency_key: idempotencyKeyProperty }, required: ['ticket_id', 'assignee_id', 'expected_revision', 'idempotency_key'], additionalProperties: false } },
  'ops.support.ticket.transition': { description: '按受控生命周期流转工单并记录原因。', inputSchema: { type: 'object', properties: { ticket_id: boundedString(36), status: { type: 'string', enum: ['open', 'in_progress', 'waiting_customer', 'resolved', 'closed'] }, reason: boundedString(1000, 3), expected_revision: positiveIntegerString, idempotency_key: idempotencyKeyProperty }, required: ['ticket_id', 'status', 'reason', 'expected_revision', 'idempotency_key'], additionalProperties: false } },
  'ops.support.ticket.comment': { description: '向工单追加内部或客户可见评论。', inputSchema: { type: 'object', properties: { ticket_id: boundedString(36), body: boundedString(10000), visibility: { type: 'string', enum: ['internal', 'customer'] }, expected_revision: positiveIntegerString, idempotency_key: idempotencyKeyProperty }, required: ['ticket_id', 'body', 'visibility', 'expected_revision', 'idempotency_key'], additionalProperties: false } },
  'ops.support.crm.export': { description: '导出最多 5000 条脱敏 CRM 投影，不含内部评论。只读。', inputSchema: { type: 'object', properties: { limit: exportLimit5000 }, additionalProperties: false } },
  'ops.incidents.list': { description: '查看有界事故列表。只读。', inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['investigating', 'identified', 'monitoring', 'resolved'] }, severity: { type: 'string', enum: ['sev1', 'sev2', 'sev3', 'sev4'] }, limit: pageLimit100, cursor: boundedString(1000) }, additionalProperties: false } },
  'ops.incident.get': { description: '查看一个事故。只读。', inputSchema: { type: 'object', properties: { incident_id: boundedString(160) }, required: ['incident_id'], additionalProperties: false } },
  'ops.incident.timeline': { description: '查看事故的不可变时间线。只读。', inputSchema: { type: 'object', properties: { incident_id: boundedString(160), limit: pageLimit200, cursor: boundedString(1000) }, required: ['incident_id'], additionalProperties: false } },
  'ops.incident.create': { description: '创建带有界影响范围和幂等键的事故。', inputSchema: { type: 'object', properties: { title: boundedString(160, 3), summary: boundedString(4000, 3), severity: { type: 'string', enum: ['sev1', 'sev2', 'sev3', 'sev4'] }, commander_id: boundedString(160), affected_components_json: boundedString(18000), affected_workspace_ids_json: boundedString(82000), idempotency_key: idempotencyKeyProperty }, required: ['title', 'summary', 'severity', 'idempotency_key'], additionalProperties: false } },
  'ops.incident.transition': { description: '按 revision、原因和幂等键推进事故状态。', inputSchema: { type: 'object', properties: { incident_id: boundedString(160), expected_revision: positiveIntegerString, to_status: { type: 'string', enum: ['investigating', 'identified', 'monitoring', 'resolved'] }, note: boundedString(4000, 3), idempotency_key: idempotencyKeyProperty }, required: ['incident_id', 'expected_revision', 'to_status', 'note', 'idempotency_key'], additionalProperties: false } },
  'ops.incident.comment': { description: '向事故时间线追加评论。', inputSchema: { type: 'object', properties: { incident_id: boundedString(160), expected_revision: positiveIntegerString, body: boundedString(4000), idempotency_key: idempotencyKeyProperty }, required: ['incident_id', 'expected_revision', 'body', 'idempotency_key'], additionalProperties: false } },
  'ops.incident.commander.assign': { description: '分配或清除事故指挥官并记录原因。', inputSchema: { type: 'object', properties: { incident_id: boundedString(160), expected_revision: positiveIntegerString, commander_id: boundedString(160), note: boundedString(4000, 3), idempotency_key: idempotencyKeyProperty }, required: ['incident_id', 'expected_revision', 'note', 'idempotency_key'], additionalProperties: false } },
  'ops.incident.scope.update': { description: '更新有界事故影响范围并保留不可变证据。', inputSchema: { type: 'object', properties: { incident_id: boundedString(160), expected_revision: positiveIntegerString, affected_components_json: boundedString(18000), affected_workspace_ids_json: boundedString(82000), note: boundedString(4000, 3), idempotency_key: idempotencyKeyProperty }, required: ['incident_id', 'expected_revision', 'affected_components_json', 'affected_workspace_ids_json', 'note', 'idempotency_key'], additionalProperties: false } },
  'ops.feature-flags.list': { description: '查看有界功能开关列表。只读。', inputSchema: { type: 'object', properties: { environment: boundedString(32), query: boundedString(200), cursor: boundedString(1000), limit: pageLimit100 }, additionalProperties: false } },
  'ops.feature-flag.upsert': { description: '创建或更新类型化功能开关，要求 revision、原因和幂等证据。', inputSchema: { type: 'object', properties: { id: boundedString(160), key: { type: 'string', minLength: 2, maxLength: 128, pattern: '^[a-z][a-z0-9_.-]+$' }, environment: { type: 'string', minLength: 2, maxLength: 32, pattern: '^[a-z][a-z0-9_-]+$' }, description: boundedString(500), default_value_json: boundedString(16384), enabled: booleanString, targets_json: boundedString(65536), valid_from: boundedString(64), valid_to: boundedString(64), expected_revision: positiveIntegerString, idempotency_key: idempotencyKeyProperty, reason: boundedString(500, 3) }, required: ['key', 'environment', 'description', 'default_value_json', 'idempotency_key', 'reason'], additionalProperties: false } },
  'ops.feature-flag.emergency.set': { description: '紧急停用或恢复功能开关，要求 revision、原因和幂等证据。', inputSchema: { type: 'object', properties: { id: boundedString(160), disabled: booleanString, expected_revision: positiveIntegerString, idempotency_key: idempotencyKeyProperty, reason: boundedString(500, 3) }, required: ['id', 'disabled', 'expected_revision', 'idempotency_key', 'reason'], additionalProperties: false } },
  'ops.feature-flag.events': { description: '查看一个功能开关的不可变事件历史。只读。', inputSchema: { type: 'object', properties: { flag_id: boundedString(160), limit: pageLimit100 }, required: ['flag_id'], additionalProperties: false } },
  'ops.feature-flag.evaluate': { description: '评估一个授权身份或工作区的功能开关，不返回目标列表。只读。', inputSchema: { type: 'object', properties: { flag_key: boundedString(128, 2), environment: boundedString(32, 2), identity_id: boundedString(160), target_workspace_id: boundedString(160), bucket_subject: boundedString(256), at: boundedString(64) }, required: ['flag_key', 'environment'], additionalProperties: false } },
  'ops.finance.search': { description: '跨授权范围检索有界脱敏财务事实，不返回凭据、支付 URL、原始 Provider 内容或完整 Provider 交易号。只读。', inputSchema: { type: 'object', properties: { workspace_ids_json: boundedString(33000), kinds_json: boundedString(256), statuses_json: boundedString(1500), text: boundedString(200), from_at: boundedString(64), to_at: boundedString(64), cursor: boundedString(4096), snapshot_at: boundedString(64), limit: pageLimit100 }, additionalProperties: false } },
  'ops.finance.detail': { description: '按可选版本和快照读取一条脱敏财务事实。只读。', inputSchema: { type: 'object', properties: { target_workspace_id: boundedString(128), kind: { type: 'string', enum: ['recharge_order', 'wallet_transaction', 'subscription_order', 'usage_entry', 'model_usage'] }, record_id: boundedString(256), expected_version: boundedString(128), snapshot_at: boundedString(64) }, required: ['target_workspace_id', 'kind', 'record_id'], additionalProperties: false } },
  'ops.finance.export': { description: '导出最多 5000 条脱敏财务事实，不返回敏感 Provider 字段。只读。', inputSchema: { type: 'object', properties: { workspace_ids_json: boundedString(33000), kinds_json: boundedString(256), statuses_json: boundedString(1500), text: boundedString(200), from_at: boundedString(64), to_at: boundedString(64), snapshot_at: boundedString(64), limit: pageLimit100 }, additionalProperties: false } },
  'ops.users.list': { description: '跨工作区查询用户成员关系；仅平台运营可用。只读。', inputSchema: { type: 'object', properties: { query: { type: 'string' }, status: { type: 'string', enum: ['invited', 'active', 'suspended'] }, workspace_id: { type: 'string' }, offset: { type: 'string' }, limit: { type: 'string' } }, additionalProperties: false } },
  'ops.users.export': { description: '按筛选条件导出跨工作区用户成员关系；仅平台运营可用，最多 5000 条。只读。', inputSchema: { type: 'object', properties: { query: { type: 'string' }, status: { type: 'string', enum: ['invited', 'active', 'suspended'] }, workspace_id: { type: 'string' }, limit: { type: 'string' }, format: { type: 'string', enum: ['csv', 'json'] } }, additionalProperties: false } },
  'ops.commercial.export': { description: '导出平台套餐、加购、优惠券和灰度规则；仅平台运营可用，不包含支付密钥。只读。', inputSchema: { type: 'object', properties: { format: { type: 'string', enum: ['csv', 'json'] } }, additionalProperties: false } },
  'ops.user.detail': { description: '查看持久平台身份、脱敏会话、生命周期事件和成员关系；仅平台运营可用。只读。', inputSchema: { type: 'object', properties: { identity_id: { type: 'string' }, issuer: { type: 'string' }, external_subject: { type: 'string' } }, additionalProperties: false } },
  'ops.user.suspend': { description: '停用单个成员关系，或全局停用平台身份并撤销其会话；仅平台运营可用。', inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['membership', 'identity'] }, workspace_id: { type: 'string' }, external_subject: { type: 'string' }, identity_id: { type: 'string' }, expected_revision: { type: 'string' }, idempotency_key: { type: 'string' }, reason: { type: 'string' } }, required: ['reason'], additionalProperties: false } },
  'ops.user.activate': { description: '恢复单个成员关系，或恢复平台身份但不复活旧会话；仅平台运营可用。', inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['membership', 'identity'] }, workspace_id: { type: 'string' }, external_subject: { type: 'string' }, identity_id: { type: 'string' }, expected_revision: { type: 'string' }, idempotency_key: { type: 'string' }, reason: { type: 'string' } }, required: ['reason'], additionalProperties: false } },
  'ops.user.risk.transition': { description: '更新平台身份风险决策；block 会撤销全部活动会话。仅平台运营可用。', inputSchema: { type: 'object', properties: { identity_id: { type: 'string' }, risk_level: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, risk_decision: { type: 'string', enum: ['allow', 'step_up', 'block'] }, expected_revision: { type: 'string' }, idempotency_key: { type: 'string' }, reason: { type: 'string' }, evidence_json: { type: 'string' } }, required: ['identity_id', 'risk_level', 'risk_decision', 'expected_revision', 'idempotency_key', 'reason'], additionalProperties: false } },
  'ops.user.session.revoke': { description: '撤销一个平台认证会话并写入不可变审计；仅平台运营可用。', inputSchema: { type: 'object', properties: { identity_id: { type: 'string' }, session_id: { type: 'string' }, expected_revision: { type: 'string' }, idempotency_key: { type: 'string' }, reason: { type: 'string' } }, required: ['identity_id', 'session_id', 'expected_revision', 'idempotency_key', 'reason'], additionalProperties: false } },
  'ops.commercial.offers.list': { description: '查看可配置套餐目录。只读。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  'ops.commercial.offer.upsert': { description: '创建或调整套餐目录和人民币价格。', inputSchema: { type: 'object', properties: { code: { type: 'string' }, name: { type: 'string' }, billing_cycle: { type: 'string', enum: ['monthly', 'annual'] }, price_cny: { type: 'string' }, included_stores: { type: 'string' }, included_tasks: { type: 'string' }, active: { type: 'string', enum: ['true', 'false'] }, valid_from: { type: 'string' }, valid_to: { type: 'string' }, expected_revision: { type: 'string' }, reason: { type: 'string' } }, required: ['code', 'name', 'billing_cycle', 'price_cny', 'included_stores', 'included_tasks', 'reason'], additionalProperties: false } },
  'ops.commercial.addons.list': { description: '查看平台和高成本能力加购目录。只读。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  'ops.commercial.addon.upsert': { description: '创建或调整加购能力和人民币价格。', inputSchema: { type: 'object', properties: { code: { type: 'string' }, name: { type: 'string' }, kind: { type: 'string', enum: ['platform', 'image_generation', 'bulk_sync'] }, price_cny: { type: 'string' }, units: { type: 'string' }, active: { type: 'string', enum: ['true', 'false'] }, expected_revision: { type: 'string' }, reason: { type: 'string' } }, required: ['code', 'name', 'kind', 'price_cny', 'units'], additionalProperties: false } },
  'ops.commercial.coupons.list': { description: '查看优惠券目录。只读。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  'ops.commercial.coupon.upsert': { description: '创建或调整优惠券规则。', inputSchema: { type: 'object', properties: { code: { type: 'string' }, discount_type: { type: 'string', enum: ['fixed_cny', 'percent'] }, discount_value: { type: 'string' }, max_redemptions: { type: 'string' }, active: { type: 'string', enum: ['true', 'false'] }, valid_from: { type: 'string' }, valid_to: { type: 'string' }, expected_revision: { type: 'string' }, reason: { type: 'string' } }, required: ['code', 'discount_type', 'discount_value', 'max_redemptions'], additionalProperties: false } },
  'ops.commercial.rollouts.list': { description: '查看套餐灰度规则。只读。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  'ops.commercial.rollout.upsert': { description: '创建或调整套餐灰度规则。', inputSchema: { type: 'object', properties: { offer_code: { type: 'string' }, workspace_id: { type: 'string' }, percentage: { type: 'string' }, enabled: { type: 'string', enum: ['true', 'false'] }, reason: { type: 'string' }, expected_revision: { type: 'string' } }, required: ['offer_code', 'percentage', 'reason'], additionalProperties: false } },
  'ops.growth.funnel': { description: '查看按渠道分组的订阅转化事件漏斗。只读。', inputSchema: { type: 'object', properties: { source_channel: { type: 'string' }, date_from: { type: 'string' }, date_to: { type: 'string' } }, additionalProperties: false } },
  'ops.alerts.list': { description: '查看当前工作区平台运营告警；支持平台、店铺、告警编码和对象筛选。只读。', inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'acknowledged'] }, limit: { type: 'string' }, platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, account_id: { type: 'string' }, code: { type: 'string' }, entity_type: { type: 'string' }, entity_id: { type: 'string' } }, additionalProperties: false } },
  'ops.alert.ack': { description: '确认一条平台运营告警并记录处理原因。', inputSchema: { type: 'object', properties: { alert_id: { type: 'string' }, reason: { type: 'string' } }, required: ['alert_id', 'reason'], additionalProperties: false } },
  'ops.marketing.queue': { description: '查看当前工作区营销队列；需要有效工作区角色或显式 support 授权。platform_ops 单独无权读取客户商品、素材、内容或发布任务详情。', inputSchema: { type: 'object', properties: { limit: { type: 'string' }, platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, account_id: { type: 'string' }, product_id: { type: 'string' }, task_id: { type: 'string' }, state: { type: 'string' } }, additionalProperties: false } },
  'ops.marketing.queue.assign': { description: '为营销队列任务分配负责人；需要有效工作区角色或显式 support 授权，platform_ops 单独无权操作客户任务。', inputSchema: { type: 'object', properties: { item_type: { type: 'string', enum: ['generation', 'publish'] }, item_id: { type: 'string' }, operator_id: { type: 'string' }, expected_revision: { type: 'string' }, reason: { type: 'string' } }, required: ['item_type', 'item_id', 'operator_id', 'reason'], additionalProperties: false } },
  'ops.marketing.visual.review': { description: '审查当前工作区已归档的视觉候选；需要有效工作区角色或显式 support 授权，platform_ops 单独无权操作。', inputSchema: { type: 'object', properties: { visual_refs_json: { type: 'string' }, status: { type: 'string', enum: ['passed', 'blocked'] }, expected_revision: { type: 'string' }, reason: { type: 'string' } }, required: ['visual_refs_json', 'status', 'reason'], additionalProperties: false } },
  'ops.marketing.generation.retry': { description: '安全重试当前工作区失败的生成任务；需要有效工作区角色或显式 support 授权，platform_ops 单独无权操作。', inputSchema: { type: 'object', properties: { job_id: { type: 'string' }, reason: { type: 'string' } }, required: ['job_id', 'reason'], additionalProperties: false } },
  'ops.marketing.publish.acknowledge': { description: '确认当前工作区被平台驳回或未知的发布任务；需要有效工作区角色或显式 support 授权，platform_ops 单独无权操作。', inputSchema: { type: 'object', properties: { publish_job_id: { type: 'string' }, reason: { type: 'string' } }, required: ['publish_job_id', 'reason'], additionalProperties: false } },
  'ops.marketing.revision.create': { description: '从当前工作区平台驳回的发布版本创建待审核修正版；需要有效工作区角色或显式 support 授权，platform_ops 单独无权操作。', inputSchema: { type: 'object', properties: { publish_job_id: { type: 'string' }, changes_json: { type: 'string' }, locked_fields_json: { type: 'string' }, reason: { type: 'string' }, expected_revision: { type: 'string' } }, required: ['publish_job_id', 'changes_json', 'reason'], additionalProperties: false } },
  'ops.member.upsert': { description: '创建或更新工作区成员角色和状态。', inputSchema: { type: 'object', properties: { external_subject: { type: 'string' }, display_name: { type: 'string' }, role: { type: 'string', enum: ['workspace_owner', 'merchant_admin', 'operator', 'support', 'finance', 'platform_ops'] }, status: { type: 'string', enum: ['invited', 'active', 'suspended'] }, reason: { type: 'string' } }, required: ['external_subject', 'role'], additionalProperties: false } },
  'ops.member.suspend': { description: '停用工作区成员并保留审计。', inputSchema: { type: 'object', properties: { external_subject: { type: 'string' }, reason: { type: 'string' } }, required: ['external_subject', 'reason'], additionalProperties: false } },
  'subscription.get': { description: '查看当前工作区订阅状态和周期。只读。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  'subscription.orders.list': { description: '默认查看本人订阅订单；工作区范围需要账务管理权限。只读。', inputSchema: { type: 'object', properties: { limit: { type: 'string' }, scope: { type: 'string', enum: ['mine', 'workspace'] } }, additionalProperties: false } },
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
  'billing.export': { description: '默认导出本人账务流水；工作区范围需要账务管理权限。金额为人民币元。只读。', inputSchema: { type: 'object', properties: { limit: { type: 'string' }, format: { type: 'string', enum: ['csv', 'json'] }, from_at: { type: 'string' }, to_at: { type: 'string' }, scope: { type: 'string', enum: ['mine', 'workspace'] } }, additionalProperties: false } },
  'platform.settings.get': {
    description: '查看平台启用状态和店铺展示配置。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'platform.settings.update': {
    description: '调整平台启用状态、展示名称和店铺别名。',
    inputSchema: { type: 'object', properties: { platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, enabled: { type: 'string', enum: ['true', 'false'] }, display_name: { type: 'string' }, store_alias: { type: 'string' }, expected_revision: { type: 'string' }, reason: { type: 'string' } }, required: ['platform', 'reason'], additionalProperties: false },
  },
  'platform.media.spec.list': {
    description: '列出持久化的平台媒体规格及生产证据状态。只读且 fail-closed：证据缺失或过期时明确不可用，不从 fixture 或标签推断。',
    inputSchema: { type: 'object', properties: { platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, placement: boundedString(200), device: { type: 'string', enum: ['desktop', 'mobile'] }, status: { type: 'string', enum: ['draft', 'approved', 'expired'] }, at: { type: 'string', description: '可选 ISO-8601 评估时间。' } }, additionalProperties: false },
  },
  'platform.media.spec.get': {
    description: '读取单个平台媒体规格、不可变摘要和生产证据元数据。只读；记录或可信证据缺失时 fail-closed。',
    inputSchema: { type: 'object', properties: { id: boundedString(200), at: { type: 'string', description: '可选 ISO-8601 评估时间。' } }, required: ['id'], additionalProperties: false },
  },
  'platform.media.spec.create': {
    description: '经交互确认，从结构化 JSON 和可审计生产证据创建媒体规格草稿。fail-closed：不会自动批准，证据缺失、无效或不匹配即拒绝。',
    inputSchema: { type: 'object', properties: { id: boundedString(200), platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, placement: boundedString(200), device: { type: 'string', enum: ['desktop', 'mobile'] }, version: boundedString(100), spec_json: jsonObject('结构化平台媒体规格 JSON 对象。'), source_url: boundedString(2000), source_sha256: { type: 'string', pattern: '^(?:sha256:)?[A-Fa-f0-9]{64}$' }, checked_at: { type: 'string' }, evidence_artifact_ref: boundedString(2000), evidence_artifact_sha256: { type: 'string', pattern: '^(?:sha256:)?[A-Fa-f0-9]{64}$' }, expires_at: { type: 'string' }, expected_revision: { type: 'string', enum: ['0'], description: '必须为 0，声明仅创建语义。' }, idempotency_key: idempotencyKeyProperty, reason: reasonProperty }, required: ['platform', 'placement', 'device', 'version', 'spec_json', 'source_url', 'source_sha256', 'checked_at', 'expected_revision', 'idempotency_key', 'reason'], additionalProperties: false },
  },
  'platform.media.spec.update': {
    description: '经交互确认，以结构化 JSON merge patch 和乐观锁更新媒体规格草稿。修订过期、已批准不可变、生产证据无效或幂等冲突均 fail-closed。',
    inputSchema: { type: 'object', properties: { id: boundedString(200), patch_json: jsonObject('只含可变媒体规格字段的结构化 merge-patch JSON 对象。'), expected_revision: positiveIntegerString, idempotency_key: idempotencyKeyProperty, reason: reasonProperty }, required: ['id', 'patch_json', 'expected_revision', 'idempotency_key', 'reason'], additionalProperties: false },
  },
  'platform.media.spec.approve': {
    description: '经交互确认，仅在不可变生产证据、哈希和有效期齐全时批准草稿。修订过期、证据缺失或作用域冲突均 fail-closed。',
    inputSchema: { type: 'object', properties: { id: boundedString(200), expected_revision: positiveIntegerString, idempotency_key: idempotencyKeyProperty, reason: reasonProperty }, required: ['id', 'expected_revision', 'idempotency_key', 'reason'], additionalProperties: false },
  },
  'platform.media.spec.expire': {
    description: '经交互确认，以乐观锁和审计意图使媒体规格过期。修订过期或幂等冲突均 fail-closed，且不会静默恢复证据。',
    inputSchema: { type: 'object', properties: { id: boundedString(200), expected_revision: positiveIntegerString, idempotency_key: idempotencyKeyProperty, reason: reasonProperty }, required: ['id', 'expected_revision', 'idempotency_key', 'reason'], additionalProperties: false },
  },
  'platform.mapping.preflight': {
    description: '使用不可变生产 schema 和 mapping 证据评估结构化字段映射。只读且 fail-closed：证据未验证、未知字段、确认过期或哈希漂移时不可发布。',
    inputSchema: { type: 'object', properties: { input_json: jsonObject('结构化 PlatformFieldMappingGateInput JSON 对象，含 schema、mapping、源分页、远端快照和不可变证据。') }, required: ['input_json'], additionalProperties: false },
  },
  'platform.model.status': { description: '查看模型和中转服务可用性。只读。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  'billing.status': {
    description: '查看当前工作区余额、充值渠道和计费模式。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'billing.model-usage.statement': {
    description: '查看当前工作区模型用量汇总。只读，不返回凭据或跨工作区数据。',
    inputSchema: { type: 'object', properties: { from_at: { type: 'string' }, to_at: { type: 'string' }, limit: { type: 'string' }, scope: { type: 'string', enum: ['mine', 'workspace'] } }, additionalProperties: false },
  },
  'billing.recharge.create': {
    description: '创建支付宝或微信充值订单；生产环境必须等待支付服务商回调确认后才入账。',
    inputSchema: { type: 'object', properties: { channel: { type: 'string', enum: ['alipay', 'wechat'] }, amount_cny: { type: 'string' }, idempotency_key: { type: 'string' } }, required: ['channel', 'amount_cny'], additionalProperties: false },
  },
  'billing.recharge.get': {
    description: '默认查询本人的充值订单；工作区范围需要账务管理权限。正式订单只接受支付服务商回调。只读。',
    inputSchema: { type: 'object', properties: { order_id: { type: 'string' }, scope: { type: 'string', enum: ['mine', 'workspace'] } }, required: ['order_id'], additionalProperties: false },
  },
  'billing.recharge.list': {
    description: '查看当前工作区充值订单，可按逗号分隔的状态筛选。只读。',
    inputSchema: { type: 'object', properties: { states: { type: 'string' }, limit: { type: 'string' }, scope: { type: 'string', enum: ['mine', 'workspace'] } }, additionalProperties: false },
  },
  'billing.transactions': {
    description: '查看当前工作区充值和消费流水。只读。',
    inputSchema: { type: 'object', properties: { limit: { type: 'string' }, scope: { type: 'string', enum: ['mine', 'workspace'] } }, additionalProperties: false },
  },
  'workspace.deactivate': {
    description: '停用商家工作区但不删除任何数据；停用后保留健康检查和重新启用入口。',
    inputSchema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'], additionalProperties: false },
  },
  'workspace.activate': {
    description: '重新启用已停用的商家工作区，不改变已保存的数据。',
    inputSchema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'], additionalProperties: false },
  },
  'ops.data.delete.list': { description: '查看当前工作区数据删除申请；只读。', inputSchema: { type: 'object', properties: { limit: { type: 'string' } }, additionalProperties: false } },
  'ops.data.delete.cancel': { description: '取消尚未执行的数据删除申请；实际删除不在此接口执行。', inputSchema: { type: 'object', properties: { request_id: { type: 'string' }, reason: { type: 'string' } }, required: ['request_id', 'reason'], additionalProperties: false } },
  'ops.data.delete.approve': { description: '记录一名独立运营人员的删除审批；第二次审批后仍需外部删除执行与证明。', inputSchema: { type: 'object', properties: { request_id: { type: 'string' }, reason: { type: 'string' } }, required: ['request_id', 'reason'], additionalProperties: false } },
  'workspace.data.delete.request': { description: '登记数据删除申请；仅进入宽限期和双人审批流程，不立即删除数据。', inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['workspace', 'assets', 'business'] }, reason: { type: 'string' }, idempotency_key: { type: 'string' } }, required: ['scope', 'reason', 'idempotency_key'], additionalProperties: false } },
  'platform.store.list': {
    description: '查看当前工作区六平台店铺账号及脱敏连接/读写就绪状态。只读，不返回平台凭据。',
    inputSchema: { type: 'object', properties: { platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] } }, additionalProperties: false },
  },
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
  'catalog.image.retry': {
    description: '安全重试尚未启动 Provider 且没有候选或对账证据的图片任务。',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' }, expected_revision: positiveIntegerString, idempotency_key: idempotencyKeyProperty }, required: ['job_id', 'idempotency_key'], additionalProperties: false },
  },
  'catalog.image.get': {
    description: '查询商品主图生成任务及结果。',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' }, visual_ref: { type: 'string' } }, additionalProperties: false },
  },
  'catalog.image.select': {
    description: '将已归档并通过自动检查的候选保存为商品首选主图；不会审核、批准或发布。',
    inputSchema: { type: 'object', properties: { job_id: boundedString(200), visual_ref: boundedString(200), expected_revision: positiveIntegerString, idempotency_key: idempotencyKeyProperty, reason: reasonProperty, confirmation_ticket_nonce_hash: sha256HashProperty, confirmation_ticket_intent_hash: sha256HashProperty }, required: ['job_id', 'visual_ref', 'expected_revision', 'idempotency_key', 'reason', 'confirmation_ticket_nonce_hash', 'confirmation_ticket_intent_hash'], additionalProperties: false },
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
    description: '创建不可变规则版本；激活规则需要规则发布权限和审批证据。approval_json 需包含 approval_ref、approved_by、approved_at。',
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
    description: '上传用户已附加的本地素材并自动完成安全检查。附件优先传绝对 file_path，由 bridge 读取文件；不要在终端生成或向模型传递 base64。图片生成任务可同时携带 continuation_kind=image_generation 及当前商品、任务和生成参数；扫描和权益检查通过后必须等待商家确认，确认前不会调用图片模型。上传后本工具会在同一调用内有界等待检查结果：检查中无需操作，风险阻断时只需重新上传。绝对不要调用 automation.scan 推进文件检查，也不要要求用户、平台人员或人工证据完成检查。单文件最多 50MB。',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, mime_type: { type: 'string' }, file_path: { type: 'string', description: '用户在当前会话明确附加的本地文件绝对路径。' }, content_base64: { type: 'string', description: '仅用于已经很小的内联内容；本地附件请使用 file_path。' }, sha256: { type: 'string' }, rights_scope: { type: 'string', enum: ['owned', 'commercial_authorized', 'limited_use', 'internal_only', 'unknown', 'unusable'] }, applicable_platforms_json: { type: 'string' }, applicable_regions_json: { type: 'string' }, usage_scopes_json: { type: 'string' }, valid_from: { type: 'string' }, valid_to: { type: 'string' }, ai_modification_allowed: { type: 'string', enum: ['true', 'false'] }, continuation_kind: { type: 'string', enum: ['image_generation'] }, continuation_product_id: { type: 'string' }, continuation_task_id: { type: 'string' }, continuation_content_version_id: { type: 'string' }, continuation_sku_ids_json: { type: 'string', description: '续跑图片生成时使用的 SKU ID 字符串数组 JSON。' }, continuation_direction: { type: 'string' }, continuation_count: { type: 'string' }, continuation_idempotency_key: { type: 'string' } }, required: ['name', 'mime_type'], oneOf: [{ required: ['file_path'] }, { required: ['content_base64'] }], additionalProperties: false },
  },
  'asset.upload.batch': {
    description: '批量上传素材到隔离区；单批最多20个、总大小最多250MB。assets_json 必须是 JSON 数组字符串，每项至少包含 name、mime_type、content_base64，可选 rights_scope、applicable_platforms_json、applicable_regions_json、usage_scopes_json、valid_from、valid_to、ai_modification_allowed（true/false 字符串）。',
    inputSchema: { type: 'object', properties: { assets_json: { type: 'string' } }, required: ['assets_json'], additionalProperties: false },
  },
  'asset.scan': {
    description: '平台安全扫描服务内部回调；商家和 ChatGPT 不应调用或提交扫描证据。',
    inputSchema: { type: 'object', properties: { asset_id: { type: 'string' }, scan_evidence_ref: { type: 'string' } }, required: ['asset_id', 'scan_evidence_ref'], additionalProperties: false },
  },
  'asset.generation.confirm': {
    description: '确认素材已通过安全扫描和权益检查；确认后平台 Worker 才允许调用图片模型生成。',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'], additionalProperties: false },
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
        brand_id: { type: 'string', description: '受限成员必须选择其拥有编辑权限的品。' },
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
  'delivery.bundle.verify': {
    description: '以可信 manifest SHA-256 验证结构化交付 manifest 和文件清单。只读且 fail-closed：缺失、额外、格式错误或哈希/大小/MIME 不符均返回 invalid，不伪造生产证据。',
    inputSchema: { type: 'object', properties: { manifest_json: jsonObject('结构化 DeliveryBundleManifest JSON 对象。'), files_json: jsonArray('结构化 DeliveryBundleFile JSON 数组；二进制内容使用服务端支持的编码表示。'), expected_manifest_hash: { type: 'string', pattern: '^(?:sha256:)?[A-Fa-f0-9]{64}$' } }, required: ['manifest_json', 'files_json', 'expected_manifest_hash'], additionalProperties: false },
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
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, output: { type: 'string', enum: ['script', 'storyboard', 'rendering'] }, context_json: { type: 'string' }, idempotency_key: { type: 'string', description: '重试同一视频请求时保持不变，避免重复渲染和重复计费' } }, required: ['prompt', 'output', 'context_json'], additionalProperties: false },
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

function taskDecisionUiHtml(kind) {
  const copy = kind === 'creative'
    ? { title: '选择一个创意方向', summary: '三个方向各有侧重。先比较，再确认最适合当前商品的一项。', cta: '确认选择' }
    : kind === 'diff'
      ? { title: '比较内容版本', summary: '逐项查看变化，并明确选择要保留的版本。历史版本不会被覆盖。', cta: '保留所选版本' }
      : { title: '最终发布确认', summary: '发布会进入平台队列。请核对对象、变更、费用和影响后再确认。', cta: '确认发布' }
  return String.raw`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${copy.title}</title><style>
:root{color-scheme:light;--bg:#f6f8f7;--card:#fff;--text:#17211c;--muted:#53645b;--line:#d8e0db;--accent:#146c43;--accent-soft:#e7f4ec;--focus:#1878d1;--danger:#a4343e;--danger-soft:#fff1f2;--shadow:0 10px 28px rgba(20,45,31,.08)}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#101512;--card:#18201b;--text:#f2f6f3;--muted:#bdc9c1;--line:#3c4a41;--accent:#9fd27e;--accent-soft:#26392d;--focus:#72b7ff;--danger:#ff9b9f;--danger-soft:#321e20;--shadow:0 12px 30px rgba(0,0,0,.28)}}
*{box-sizing:border-box}body{margin:0;background:transparent;color:var(--text);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}main{background:var(--bg);padding:24px;border-radius:18px}header{max-width:760px}h1{font-size:21px;line-height:1.3;letter-spacing:-.015em;margin:0 0 6px}.summary{color:var(--muted);margin:0}.options,.diff-list,.review-list{display:grid;gap:12px;margin:20px 0}.option{display:block;position:relative}.option input{position:absolute;inset:18px auto auto 18px;width:18px;height:18px;margin:0;accent-color:var(--accent)}.option-body{display:block;min-height:48px;padding:16px 16px 16px 50px;border:1px solid var(--line);border-radius:14px;background:var(--card);box-shadow:0 1px 0 rgba(0,0,0,.02);cursor:pointer;transition:border-color .16s ease,box-shadow .16s ease,background .16s ease}.option input:checked+.option-body{border-color:var(--accent);background:var(--accent-soft);box-shadow:0 0 0 1px var(--accent),var(--shadow)}.option input:focus-visible+.option-body,button:focus-visible,input[type=checkbox]:focus-visible{outline:3px solid var(--focus);outline-offset:3px}.option-body:hover{border-color:var(--accent)}.option-title{display:block;font-size:16px;font-weight:720}.option-lead{display:block;margin-top:3px;color:var(--muted)}.facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 16px;margin:12px 0 0}.fact{min-width:0}.fact strong,.section-label{display:block;color:var(--muted);font-size:12px;font-weight:650;margin-bottom:2px}.risk{display:block;margin-top:10px;padding:8px 10px;border-radius:9px;background:var(--danger-soft);color:var(--danger);font-size:13px}.diff-item,.review-item{padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:var(--card)}.diff-path,.review-title{font-weight:700}.diff-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:9px}.diff-value{min-width:0;padding:10px;border-radius:9px;background:var(--bg);overflow-wrap:anywhere}.diff-value strong{display:block;color:var(--muted);font-size:12px;margin-bottom:3px}.review-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.ack{display:flex;align-items:flex-start;gap:10px;margin:18px 0;color:var(--text)}.ack input{width:20px;height:20px;margin:2px 0 0;accent-color:var(--accent);flex:0 0 auto}.actions{display:flex;align-items:center;gap:14px;flex-wrap:wrap}button{min-height:48px;border:0;border-radius:12px;padding:12px 22px;background:var(--accent);color:#fff;font:inherit;font-weight:750;cursor:pointer;transition:filter .15s ease,opacity .15s ease}button:hover:not(:disabled){filter:brightness(.94)}button:active:not(:disabled){filter:brightness(.86)}button:disabled{cursor:not-allowed;opacity:.44}.status{min-height:24px;color:var(--muted)}.status.error{color:var(--danger)}.empty{margin:20px 0;padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--muted)}.hidden{display:none!important}
@media(max-width:620px){main{padding:18px}.facts,.diff-grid,.review-grid{grid-template-columns:1fr}.actions button{width:100%}}@media(prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}
</style></head><body><main data-component="${kind}" aria-labelledby="title"><header><h1 id="title">${copy.title}</h1><p class="summary">${copy.summary}</p></header><section id="options" class="options" aria-label="可选项"></section><section id="details"></section><div id="empty" class="empty hidden" role="status">当前没有足够的信息完成这一步，请返回对话刷新结果。</div><label id="ack" class="ack hidden"><input id="ack-input" type="checkbox"><span>我已核对发布对象、内容变化、费用说明和进入平台队列后的影响。</span></label><div class="actions"><button id="primary" type="button" disabled>${copy.cta}</button><div id="status" class="status" role="status" aria-live="polite">请先选择一项。</div></div><script>
(function(){
  var kind=${JSON.stringify(kind)};var selected='';var payload=null;var primary=document.getElementById('primary');var statusNode=document.getElementById('status');var optionsNode=document.getElementById('options');var detailsNode=document.getElementById('details');var emptyNode=document.getElementById('empty');var ack=document.getElementById('ack');var ackInput=document.getElementById('ack-input');
  var object=function(value){return value&&typeof value==='object'&&!Array.isArray(value)?value:null};var parse=function(value){if(typeof value!=='string')return value;try{return JSON.parse(value)}catch{return null}};var value=function(input,fallback){if(input===null||input===undefined||input==='')return fallback||'未提供';if(Array.isArray(input))return input.map(function(item){return value(item,'')}).filter(Boolean).join('、');if(typeof input==='object')return value(input.label||input.title||input.name,fallback);return String(input)};var platform=function(input){return({jd:'京东',taobao:'淘宝',tmall:'天猫',pinduoduo:'拼多多',xiaohongshu:'小红书',douyin:'抖音'})[String(input||'').toLowerCase()]||value(input,'当前平台')};var short=function(input){var output=value(input,'未提供');return output.length>180?output.slice(0,177)+'…':output};
  var raw=window.openai&&window.openai.toolOutput;raw=parse(raw);var envelope=object(raw)||{};var structured=parse(envelope.structuredContent);payload=structured===null||structured===undefined?(Array.isArray(raw)?raw:envelope):structured;var toolInput=object(window.openai&&window.openai.toolInput)||{};
  var setStatus=function(message,error){statusNode.textContent=message;statusNode.classList.toggle('error',Boolean(error))};var updatePrimary=function(){primary.disabled=kind==='publish'?!ackInput.checked:!selected;setStatus(primary.disabled?(kind==='publish'?'请先勾选确认。':'请先选择一项。'):'可以继续。',false)};
  var addOption=function(id,title,lead,facts,risk){var label=document.createElement('label');label.className='option';var radio=document.createElement('input');radio.type='radio';radio.name='decision';radio.value=id;radio.setAttribute('aria-label',title);var body=document.createElement('span');body.className='option-body';var titleNode=document.createElement('span');titleNode.className='option-title';titleNode.textContent=title;var leadNode=document.createElement('span');leadNode.className='option-lead';leadNode.textContent=lead;body.append(titleNode,leadNode);if(facts&&facts.length){var factsNode=document.createElement('span');factsNode.className='facts';facts.forEach(function(item){var fact=document.createElement('span');fact.className='fact';var key=document.createElement('strong');key.textContent=item[0];var factValue=document.createElement('span');factValue.textContent=short(item[1]);fact.append(key,factValue);factsNode.appendChild(fact)});body.appendChild(factsNode)}if(risk){var riskNode=document.createElement('span');riskNode.className='risk';riskNode.textContent='注意：'+short(risk);body.appendChild(riskNode)}radio.addEventListener('change',function(){selected=id;updatePrimary()});label.append(radio,body);optionsNode.appendChild(label)};
  var addDiff=function(change){var item=document.createElement('article');item.className='diff-item';var title=document.createElement('div');title.className='diff-path';title.textContent=value(change.path,'内容变化').replace(/^body\.?/u,'').replaceAll('.',' › ')||'内容变化';var grid=document.createElement('div');grid.className='diff-grid';[['原版本',change.before],['新版本',change.after]].forEach(function(entry){var box=document.createElement('div');box.className='diff-value';var key=document.createElement('strong');key.textContent=entry[0];var text=document.createElement('span');text.textContent=short(entry[1],'无');box.append(key,text);grid.appendChild(box)});item.append(title,grid);detailsNode.appendChild(item)};
  var addReview=function(titleText,items){var item=document.createElement('article');item.className='review-item';var title=document.createElement('div');title.className='review-title';title.textContent=titleText;var grid=document.createElement('div');grid.className='review-grid';items.forEach(function(entry){var fact=document.createElement('div');fact.className='fact';var key=document.createElement('strong');key.textContent=entry[0];var text=document.createElement('span');text.textContent=short(entry[1]);fact.append(key,text);grid.appendChild(fact)});item.append(title,grid);detailsNode.appendChild(item)};
  if(kind==='creative'){
    var directions=Array.isArray(payload)?payload:Array.isArray(payload&&payload.directions)?payload.directions:[];directions.forEach(function(direction){if(!object(direction))return;addOption(String(direction.id||''),value(direction.name,'创意方向'),value(direction.coreIdea,'查看该方向的表达重点'),[['适合',direction.fitReason],['文案',direction.copyDirection],['画面',direction.visualDirection],['结构',direction.structure]],direction.risk)});if(!directions.length)emptyNode.classList.remove('hidden');
  }else if(kind==='diff'){
    var diff=object(payload)||{};var versions=[];if(diff.fromVersionId)versions.push([String(diff.fromVersionId),'原版本','作为本次比较的对照版本']);if(diff.toVersionId)versions.push([String(diff.toVersionId),'新版本','包含本次展示的内容变化']);versions.forEach(function(entry){addOption(entry[0],entry[1],entry[2],[],null)});var changes=Array.isArray(diff.changes)?diff.changes:[];detailsNode.className='diff-list';changes.forEach(addDiff);if(versions.length<2||!changes.length)emptyNode.classList.remove('hidden');
  }else{
    var preview=object(payload)||{};var isBatch=preview.isBatch===true||Array.isArray(preview.items);var previews=isBatch?(Array.isArray(preview.items)?preview.items:[]):[preview];detailsNode.className='review-list';previews.forEach(function(item,index){var current=object(item)||{};var task=object(current.task)||{};var store=object(current.storeContext)||{};var visual=object(current.visualPreview)||{};addReview(isBatch?'发布项 '+String(index+1):'当前发布内容',[['平台',platform(task.platform||store.platform)],['店铺',value(store.alias,'已选店铺')],['内容变化',value(current.changes,'已批准内容')],['图片',Number.isFinite(visual.count)?String(visual.count)+' 张':'沿用已批准图片']])});addReview('费用与影响',[['费用','本次确认不触发新的模型生成；平台侧费用按店铺规则结算'],['提交后','内容将进入平台发布队列，排队不等于发布成功'],['异常处理','状态不明确时先查询结果，不会自动重复提交'],['撤回影响','进入平台处理后不保证可以立即撤回']]);ack.classList.remove('hidden');ackInput.addEventListener('change',updatePrimary);if(!previews.length)emptyNode.classList.remove('hidden');
  }
  var callTool=async function(name,args){if(!window.openai||typeof window.openai.callTool!=='function')throw new Error('当前宿主暂不支持卡片内操作，请在对话中继续。');var confirmation=await window.openai.callTool('workspace.interactive.confirm',{confirmation:'I_CONFIRM_INTERACTIVE_WRITES'});if(confirmation&&confirmation.isError)throw new Error('确认未生效，请在对话中重试。');var ticket=object(confirmation&&confirmation.ticket)||{};var confirmedArgs=(name==='publish.confirm'||name==='publish.batch.confirm')&&ticket.nonce_hash&&ticket.intent_hash?Object.assign({},args,{confirmation_ticket_nonce_hash:String(ticket.nonce_hash),confirmation_ticket_intent_hash:String(ticket.intent_hash)}):args;var response=await window.openai.callTool(name,confirmedArgs);if(response&&response.isError)throw new Error(value(response.content&&response.content[0]&&response.content[0].text,'这一步没有完成，请在对话中查看原因。'));return response};
  primary.addEventListener('click',async function(){if(primary.disabled)return;primary.disabled=true;setStatus(kind==='creative'?'正在确认方向…':kind==='diff'?'正在保留版本…':'正在提交发布确认…',false);try{if(kind==='creative'){await callTool('task.select_direction',{task_id:value(toolInput.task_id,''),direction_id:selected})}else if(kind==='diff'){await callTool('content.restore',{content_version_id:selected})}else{var preview=object(payload)||{};if(preview.isBatch===true||Array.isArray(preview.items)){var confirmations=(Array.isArray(preview.items)?preview.items:[]).map(function(item,index){return{task_id:item.task&&item.task.id,content_version_id:item.version&&item.version.id,confirmation_hash:item.confirmationHash,remote_snapshot_hash:item.remoteSnapshotHash,idempotency_key:'publish-card-'+String(index+1)+'-'+String(Date.now())}});await callTool('publish.batch.confirm',{batch_id:preview.batchId||preview.batch&&preview.batch.id,confirmations_json:JSON.stringify(confirmations)})}else{await callTool('publish.confirm',{task_id:preview.task&&preview.task.id,content_version_id:preview.version&&preview.version.id,confirmation_hash:preview.confirmationHash,remote_snapshot_hash:preview.remoteSnapshotHash,idempotency_key:'publish-card-'+String(Date.now())})}}setStatus(kind==='creative'?'方向已确认。':kind==='diff'?'已保留所选版本并创建新的可审阅版本。':'发布请求已提交，请以平台最终状态为准。',false);primary.textContent='已完成'}catch(error){setStatus(error&&error.message?error.message:'这一步没有完成，请在对话中重试。',true);primary.disabled=false}});
  updatePrimary();
})();
</script></main></body></html>`
}

const creativeChoiceUiHtml = () => taskDecisionUiHtml('creative')
const contentDiffUiHtml = () => taskDecisionUiHtml('diff')
const publishConfirmUiHtml = () => taskDecisionUiHtml('publish')

function imageCandidateChoiceUiHtml() {
  return rawImageCandidateChoiceUiHtml().replaceAll('无需找管理员', '无需人工干预')
}

function rawImageCandidateChoiceUiHtml() {
  return String.raw`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>选择主图</title><style>
:root{color-scheme:light;--surface:#fff;--surface-subtle:#f6f8f7;--text:#17211c;--muted:#53645b;--line:#d8e0db;--accent:#146c43;--on-accent:#fff;--accent-soft:#e7f4ec;--focus:#1878d1;--danger:#a4343e}@media(prefers-color-scheme:dark){:root{color-scheme:dark;--surface:#18201b;--surface-subtle:#101512;--text:#f2f6f3;--muted:#bdc9c1;--line:#46554b;--accent:#9fd27e;--on-accent:#102116;--accent-soft:#26392d;--focus:#72b7ff;--danger:#ff9b9f}}*{box-sizing:border-box}body{margin:0;background:transparent;color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}main{padding:20px;background:var(--surface-subtle);border-radius:18px}h1{margin:0;font-size:21px;line-height:1.3}.lead{margin:6px 0 0;color:var(--muted)}fieldset{min-width:0;margin:18px 0 0;padding:0;border:0}legend{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}.choices{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(180px,100%),1fr));gap:12px}.choice{position:relative;display:block;min-width:0;max-width:520px}.choice input{position:absolute;top:12px;right:12px;width:20px;height:20px;margin:0;accent-color:var(--accent);z-index:1}.choice-body{display:block;height:100%;padding:10px;border:1px solid var(--line);border-radius:14px;background:var(--surface);cursor:pointer}.choice input:checked+.choice-body{border-color:var(--accent);background:var(--accent-soft);box-shadow:0 0 0 1px var(--accent)}.choice input:focus-visible+.choice-body,button:focus-visible{outline:3px solid var(--focus);outline-offset:3px}.choice.failed .choice-body{cursor:not-allowed;opacity:.52}.choice.failed .label{color:var(--danger)}img{display:block;width:100%;height:auto;max-height:520px;aspect-ratio:1/1;object-fit:contain;border-radius:10px;background:var(--surface-subtle)}.label{display:block;padding:10px 2px 2px;font-weight:720}.actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:18px}button{min-height:48px;padding:12px 22px;border:0;border-radius:12px;background:var(--accent);color:var(--on-accent);font:inherit;font-weight:750;cursor:pointer}button:disabled{cursor:not-allowed;opacity:.44}.status{min-height:24px;color:var(--muted)}.status.error{color:var(--danger)}@media(max-width:520px){main{padding:16px}.choices{grid-template-columns:1fr 1fr}.actions button{width:100%}}@media(max-width:360px){.choices{grid-template-columns:1fr}}@media(prefers-reduced-motion:reduce){*{transition:none!important}}
</style></head><body><main id="candidate-root" aria-labelledby="candidate-title" aria-busy="false"><h1 id="candidate-title">选择一张作为主图</h1><p id="candidate-lead" class="lead">候选均已归档并通过自动检查。保存首选不会审核或发布。</p><fieldset id="candidate-fieldset"><legend>主图候选</legend><div id="choices" class="choices"></div></fieldset><div id="candidate-actions" class="actions"><button id="confirm" type="button" disabled>使用所选主图</button><div id="status" class="status" role="status" aria-live="polite">请先选择一张。</div></div><script>
(function(){
  var parse=function(value){if(typeof value!=='string')return value;try{return JSON.parse(value)}catch{return null}};var object=function(value){return value&&typeof value==='object'&&!Array.isArray(value)?value:null};
  var root=document.getElementById('candidate-root');var fieldset=document.getElementById('candidate-fieldset');var actions=document.getElementById('candidate-actions');var choices=document.getElementById('choices');var button=document.getElementById('confirm');var status=document.getElementById('status');var titleNode=document.getElementById('candidate-title');var leadNode=document.getElementById('candidate-lead');var currentState='';var stateLabel={queued:'排队中',processing:'处理中',failed:'失败',unknown:'待确认',ready:'已就绪'};var selected=0;var currentPayload={};var currentImages=[];var privateSelectionTickets=Object.create(null);var idempotencyKeys={};var inFlight=false;var pollTimer=null;var pollAttempt=0;var pollJobId='';
  var resultMeta=function(envelope,responseMetadata){return object(envelope&&envelope._meta)||object(responseMetadata&&responseMetadata.mcp_tool_result&&responseMetadata.mcp_tool_result._meta)||object(responseMetadata&&responseMetadata.call_tool_result&&responseMetadata.call_tool_result._meta)||object(responseMetadata)||{}};var resultContent=function(envelope,responseMetadata){if(Array.isArray(envelope&&envelope.content))return envelope.content;var mcp=object(responseMetadata&&responseMetadata.mcp_tool_result);if(mcp&&Array.isArray(mcp.content))return mcp.content;var call=object(responseMetadata&&responseMetadata.call_tool_result);if(call&&Array.isArray(call.content))return call.content;return[]};
  var normalize=function(value,responseMetadata){var raw=parse(value);var envelope=object(raw)||{};var structured=parse(envelope.structuredContent);var payload=object(structured)||envelope;var meta=resultMeta(envelope,responseMetadata);var metaImages=Array.isArray(meta['merchant/candidateImages'])?meta['merchant/candidateImages']:[];var metaTickets=Array.isArray(meta['merchant/candidateSelectionTickets'])?meta['merchant/candidateSelectionTickets']:[];privateSelectionTickets=Object.create(null);metaTickets.forEach(function(value){var ticket=object(value);var visualRef=String(ticket&&ticket.visual_ref||'');var nonceHash=String(ticket&&ticket.nonce_hash||'');var intentHash=String(ticket&&ticket.intent_hash||'');var expiresAt=String(ticket&&ticket.expires_at||'');if(visualRef&&/^[a-f0-9]{64}$/u.test(nonceHash)&&/^[a-f0-9]{64}$/u.test(intentHash)&&Number.isFinite(Date.parse(expiresAt))&&!privateSelectionTickets[visualRef])privateSelectionTickets[visualRef]={nonce_hash:nonceHash,intent_hash:intentHash,expires_at:expiresAt}});var structuredImages=Array.isArray(payload.image_urls)?payload.image_urls:[];var contentImages=resultContent(envelope,responseMetadata).flatMap(function(item){var entry=object(item);var mime=String(entry&&entry.mimeType||'').toLowerCase();var data=String(entry&&entry.data||'');return entry&&entry.type==='image'&&/^(?:image\/png|image\/jpeg|image\/webp)$/u.test(mime)&&/^[A-Za-z0-9+/=]+$/u.test(data)?['data:'+mime+';base64,'+data]:[]});payload=Object.assign({},payload,{image_urls:metaImages.length?metaImages:structuredImages,image_fallbacks:contentImages.length?contentImages:Array.isArray(meta['merchant/candidateImageFallbacks'])?meta['merchant/candidateImageFallbacks']:[]});currentState=String(payload&&payload.candidate_state&&payload.candidate_state.state||'').toLowerCase();return payload};
  var setBusy=function(value){inFlight=Boolean(value);root.setAttribute('aria-busy',inFlight?'true':'false')};var setStatus=function(message,error){status.textContent=(stateLabel[currentState]?'['+stateLabel[currentState]+'] ':'')+message;status.classList.toggle('error',Boolean(error));status.setAttribute('role',error?'alert':'status');status.setAttribute('aria-live',error?'assertive':'polite')};var selectionRequest=function(){return object(currentPayload.selection_request)||{}};var recoveryRequest=function(){return object(currentPayload.recovery_request)||{}};var candidateFor=function(index){var list=Array.isArray(selectionRequest().candidates)?selectionRequest().candidates:[];return object(list[index])};var availableInputs=function(){return Array.from(choices.querySelectorAll('input')).filter(function(input){return !input.disabled})};var selectedRef=function(){var candidate=candidateFor(selected-1);return String(candidate&&candidate.visual_ref||'')};var ticketFor=function(visualRef){var ticket=privateSelectionTickets[String(visualRef||'')];if(!ticket||Date.parse(ticket.expires_at)<=Date.now())return null;return ticket};
  var updateAction=function(){var inputs=Array.from(choices.querySelectorAll('input'));if(inputs.length&&availableInputs().length===0){button.dataset.mode='reload';button.textContent='重新读取图片';button.disabled=false;setStatus('所有候选图片都无法显示，请重新读取。',true);return}var persisted=String(selectionRequest().selected_visual_ref||'');if(!selected&&persisted){var savedIndex=(Array.isArray(selectionRequest().candidates)?selectionRequest().candidates:[]).findIndex(function(candidate){return String(candidate&&candidate.visual_ref||'')===persisted});var savedInput=inputs[savedIndex];if(savedInput&&!savedInput.disabled){savedInput.checked=true;selected=savedIndex+1}}var active=candidateFor(selected-1);var activeInput=inputs[selected-1];if(active&&persisted&&String(active.visual_ref||'')===persisted&&activeInput&&!activeInput.disabled){button.dataset.mode='select';button.textContent='已保存';button.disabled=true;setStatus('已保存为首选主图，尚未审核或发布',false);return}if(active&&!ticketFor(active.visual_ref)){button.dataset.mode='refresh';button.textContent='刷新候选';button.disabled=false;setStatus('当前确认已过期，请刷新候选后重试。',true);return}button.dataset.mode='select';button.textContent=currentImages.length===1?'使用这张主图':'使用所选主图';button.disabled=!selected||Boolean(activeInput&&activeInput.disabled)};
  var disableCandidate=function(input,label,title,image,ordinal,subject){input.checked=false;input.disabled=true;input.setAttribute('aria-disabled','true');input.setAttribute('aria-label','方案 '+String(ordinal)+'：'+subject+'，图片不可用');label.classList.add('failed');title.textContent='方案 '+String(ordinal)+' · 图片不可用';image.alt='方案 '+String(ordinal)+'：'+subject+'，图片不可用';if(selected===Number(input.value))selected=0;updateAction()};
  var clearPoll=function(reset){if(pollTimer!==null){clearTimeout(pollTimer);pollTimer=null}if(reset){pollAttempt=0;pollJobId=''}};
  var render=function(value,responseMetadata){var priorRef=selectedRef();var payload=normalize(value,responseMetadata);currentPayload=payload;var images=Array.isArray(payload.image_urls)?payload.image_urls.filter(function(item){return typeof item==='string'&&(/^https:\/\//iu.test(item)||/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//iu.test(item))}):[];var fallbacks=Array.isArray(payload.image_fallbacks)?payload.image_fallbacks.filter(function(item){return typeof item==='string'&&/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/iu.test(item)}):[];if(!images.length&&fallbacks.length)images=fallbacks.slice();choices.replaceChildren();selected=0;currentImages=images;button.disabled=true;button.hidden=false;fieldset.hidden=false;actions.hidden=false;button.dataset.mode='select';titleNode.textContent='选择一张作为主图';leadNode.textContent='候选均已归档并通过自动检查。保存首选不会审核或发布。';var request=selectionRequest();var candidates=Array.isArray(request.candidates)?request.candidates:[];var ready=currentState==='ready'&&images.length>0&&candidates.length>0;if(!ready){fieldset.hidden=true;if(currentState==='queued'||currentState==='processing'){button.hidden=true;titleNode.textContent='图片正在准备';leadNode.textContent=String(payload.completed_summary||'正在准备主图候选。');schedulePoll(payload);return}clearPoll(true);if(currentState==='failed'||currentState==='unknown'){var recovery=recoveryRequest();button.dataset.mode=currentState==='failed'?'regenerate':'query';button.textContent=currentState==='failed'?'回到对话重新生成':'查询图片结果';button.disabled=currentState==='unknown'&&!String(recovery.job_id||'');titleNode.textContent=currentState==='failed'?'本次生成未完成':'图片结果待确认';leadNode.textContent=String(payload.completed_summary||'可以安全恢复当前步骤。');setStatus(currentState==='failed'?'可以回到对话重新生成，不会继续读取失败任务。':'先查询最终结果，不会自动重复生成。',currentState==='failed')}else{button.hidden=true;titleNode.textContent='图片暂不可用';leadNode.textContent=String(payload.completed_summary||'请在对话中继续。');setStatus('请在对话中继续。',false)}return}clearPoll(true);images.forEach(function(src,index){var candidate=candidateFor(index);var label=document.createElement('label');label.className='choice';var input=document.createElement('input');input.type='radio';input.name='main-image';input.value=String(index+1);var ordinal=Number(candidate&&candidate.ordinal)||index+1;var subject=String(candidate&&candidate.subject_label||'商品主体');var availability=String(candidate&&candidate.availability_label||(candidate&&candidate.selectable===true?'可用':'不可用'));var alt='方案 '+String(ordinal)+'：'+subject+'，'+availability;input.setAttribute('aria-label',alt);var body=document.createElement('span');body.className='choice-body';var image=document.createElement('img');var fallback=fallbacks[index];var fallbackTried=src===fallback;image.src=src;image.alt=alt;image.loading='eager';image.decoding='async';image.referrerPolicy='no-referrer';var title=document.createElement('span');title.className='label';title.textContent='方案 '+String(ordinal)+' · '+availability;image.addEventListener('error',function(){if(!fallbackTried&&fallback&&image.src!==fallback){fallbackTried=true;image.src=fallback;return}disableCandidate(input,label,title,image,ordinal,subject)});body.append(image,title);input.disabled=!candidate||candidate.selectable!==true;input.setAttribute('aria-disabled',input.disabled?'true':'false');input.addEventListener('change',function(){selected=index+1;updateAction();setStatus(images.length===1?'已准备好，确认后保存。':'已选择方案 '+String(ordinal)+'。',false)});label.append(input,body);choices.appendChild(label);if(input.disabled){label.classList.add('failed');title.textContent='方案 '+String(ordinal)+' · 不可用';image.alt='方案 '+String(ordinal)+'：'+subject+'，不可用'}});var restoreRef=String(request.selected_visual_ref||priorRef||'');if(restoreRef){var restoreIndex=candidates.findIndex(function(candidate){return String(candidate&&candidate.visual_ref||'')===restoreRef});var restoreInput=Array.from(choices.querySelectorAll('input'))[restoreIndex];if(restoreInput&&!restoreInput.disabled){restoreInput.checked=true;selected=restoreIndex+1}}if(images.length===1){var only=choices.querySelector('input');if(only&&!only.disabled){only.checked=true;selected=1;titleNode.textContent='主图候选';setStatus('已准备好，确认后保存。',false)}}updateAction()};
  var schedulePoll=function(payload){var request=object(payload&&payload.poll_request)||{};var jobId=String(request.job_id||'');var maxAttempts=Math.min(5,Math.max(1,Number(request.max_attempts)||4));var initialDelay=Math.min(2000,Math.max(500,Number(request.initial_delay_ms)||750));var maxDelay=Math.min(5000,Math.max(initialDelay,Number(request.max_delay_ms)||4000));if(!jobId||!window.openai||typeof window.openai.callTool!=='function'){button.hidden=false;button.dataset.mode='query';button.textContent='再次查询';button.disabled=!jobId;setStatus('暂时无法自动查询，可手动再试。',true);return}if(pollJobId!==jobId){clearPoll(false);pollJobId=jobId;pollAttempt=0}if(pollAttempt>=maxAttempts){button.hidden=false;button.dataset.mode='query';button.textContent='再次查询';button.disabled=false;setStatus('自动查询已暂停，可手动再查一次。',false);return}var visibleAttempt=pollAttempt+1;var delay=Math.min(maxDelay,initialDelay*Math.pow(2,pollAttempt));setStatus('正在准备图片，自动查询 '+String(visibleAttempt)+'/'+String(maxAttempts)+'…',false);pollTimer=setTimeout(async function(){pollTimer=null;pollAttempt=visibleAttempt;setBusy(true);try{var response=await window.openai.callTool('catalog.image.get',{job_id:jobId});if(response&&response.isError)throw new Error('poll');render(response,null)}catch(error){button.hidden=false;button.dataset.mode='query';button.textContent='再次查询';button.disabled=false;setStatus('自动查询暂时失败，可手动再试。',true)}finally{setBusy(false)}},delay)};
  window.addEventListener('message',function(event){if(event.source!==window.parent)return;var message=event.data;if(!message||message.jsonrpc!=='2.0'||message.method!=='ui/notifications/tool-result')return;render(message.params||{},null)},{passive:true});var metadata=window.openai&&window.openai.toolResponseMetadata;var initial=window.openai&&window.openai.toolOutput;if(!initial&&metadata){initial=metadata.mcp_tool_result&&metadata.mcp_tool_result.structuredContent||metadata.call_tool_result&&metadata.call_tool_result.structuredContent}render({structuredContent:initial||{}},metadata||{});
  var responseCode=function(value){var envelope=object(value)||{};var structured=object(parse(envelope.structuredContent))||envelope;return String(structured.code||envelope.code||'').toUpperCase()};var errorKind=function(code){if(code==='INTERACTIVE_CONFIRMATION_TICKET_INVALID'||code==='INTERACTIVE_CONFIRMATION_INTENT_MISMATCH'||code.indexOf('CONFIRMATION_TICKET_EXPIRED')>=0||code.indexOf('TICKET_MISMATCH')>=0)return'confirmation_expired';if(code==='IMAGE_GENERATION_REVISION_CONFLICT'||code==='QUEUE_ASSIGNMENT_VERSION_CONFLICT')return'revision';if(code==='VISUAL_NOT_READY'||code==='VISUAL_NOT_FOUND'||code==='VISUAL_BLOCKED'||code==='VISUAL_SCAN_REQUIRED'||code==='VISUAL_SELECTION_SCOPE_MISMATCH')return'invalid';if(code.indexOf('UNKNOWN')>=0||code.indexOf('RECONCILIATION')>=0)return'unknown';return'unknown'};var markSelectedInvalid=function(){var inputs=Array.from(choices.querySelectorAll('input'));var input=inputs[selected-1];if(!input)return;input.disabled=true;input.setAttribute('aria-disabled','true');input.checked=true;var label=input.parentNode;if(label&&label.classList)label.classList.add('failed');var title=label&&label.querySelector?label.querySelector('.label'):null;if(title)title.textContent='当前方案已失效';button.dataset.mode='select';button.textContent='请选择其他候选';button.disabled=true};var runRefresh=async function(mode){var request=selectionRequest();var recovery=recoveryRequest();var poll=object(currentPayload.poll_request)||{};var jobId=String(request.job_id||recovery.job_id||poll.job_id||'');button.disabled=true;setStatus(mode==='query'?'正在查询图片结果…':'正在刷新候选…',false);try{var refreshed=await window.openai.callTool('catalog.image.get',{job_id:jobId});if(refreshed&&refreshed.isError)throw new Error('refresh');render(refreshed,null)}catch(error){button.dataset.mode=mode;button.textContent=mode==='query'?'再次查询':'刷新候选';button.disabled=false;setStatus(mode==='query'?'查询失败，请稍后再试。':'刷新失败，请稍后再试。',true)}};
  button.addEventListener('click',async function(){if(button.disabled||inFlight)return;var request=selectionRequest();if(!window.openai){setStatus('当前宿主暂不支持卡片内操作，请在对话中继续。',true);return}setBusy(true);try{if(button.dataset.mode==='regenerate'){var prompt='请重新调用原来的主图生成流程；沿用已确认的商品事实和生成范围，不复用失败任务。若缺少必要参数，只问我一个问题。';if(typeof window.openai.sendFollowUpMessage==='function'){try{await window.openai.sendFollowUpMessage({prompt:prompt});button.disabled=true;setStatus('已回到对话，请继续完成主图生成。',false)}catch(error){button.disabled=false;setStatus('暂时无法自动回到对话，请直接说“重新生成主图”。',true)}}else{button.disabled=true;setStatus('请在对话中说“重新生成主图”，我会重新走生成流程。',false)}return}if(typeof window.openai.callTool!=='function'){setStatus('当前宿主暂不支持卡片内操作，请在对话中继续。',true);return}if(button.dataset.mode==='reload'||button.dataset.mode==='refresh'||button.dataset.mode==='query'){await runRefresh(button.dataset.mode==='query'?'query':'refresh');return}if(!selected)return;var candidate=candidateFor(selected-1);if(!candidate||candidate.selectable!==true){setStatus('该候选当前不可用，请选择其他图片。',true);updateAction();return}var ticket=ticketFor(candidate.visual_ref);if(!ticket){button.dataset.mode='refresh';button.textContent='刷新候选';button.disabled=false;setStatus('当前确认已过期，正在刷新候选…',true);await runRefresh('refresh');return}button.disabled=true;setStatus('正在保存首选主图…',false);var intent=[request.job_id,request.expected_revision,candidate.visual_ref].join(':');var key=idempotencyKeys[intent]||(idempotencyKeys[intent]='image-select-'+(window.crypto&&typeof window.crypto.randomUUID==='function'?window.crypto.randomUUID():intent.replace(/[^A-Za-z0-9._:-]/gu,'-')));var response;try{response=await window.openai.callTool('catalog.image.select',{job_id:String(request.job_id||''),visual_ref:String(candidate.visual_ref||''),expected_revision:String(request.expected_revision||''),idempotency_key:key,reason:'用户在 ChatGPT 主图候选卡中明确选择首选主图',confirmation_ticket_nonce_hash:ticket.nonce_hash,confirmation_ticket_intent_hash:ticket.intent_hash})}catch(error){button.dataset.mode='retry';button.textContent='重试保存';button.disabled=false;setStatus('网络连接失败，请重试保存。',true);return}if(response&&response.isError){var kind=errorKind(responseCode(response));if(kind==='confirmation_expired'){setStatus('当前确认已过期，正在刷新候选…',true);await runRefresh('refresh');return}if(kind==='revision'){button.dataset.mode='refresh';button.textContent='刷新候选';button.disabled=false;setStatus('候选版本已更新，请刷新后再保存。',true);return}if(kind==='invalid'){markSelectedInvalid();setStatus('当前候选已失效，请选择其他候选；如均不可用可重新读取。',true);return}button.dataset.mode='query';button.textContent='先查询结果';button.disabled=false;setStatus('保存结果尚未确认，请先查询，避免重复提交。',true);return}var structured=object(parse(response&&response.structuredContent))||object(response)||{};if(String(structured.preference_status||'')!=='selected'||String(structured.visual_ref||'')!==String(candidate.visual_ref||'')){button.dataset.mode='query';button.textContent='先查询结果';button.disabled=false;setStatus('保存结果尚未确认，请先查询，避免重复提交。',true);return}currentPayload=Object.assign({},currentPayload,{selection_request:Object.assign({},request,{selected_visual_ref:String(candidate.visual_ref||''),expected_revision:String(structured.revision||request.expected_revision||'')})});updateAction();try{var restored=await window.openai.callTool('catalog.image.get',{job_id:String(request.job_id||'')});if(restored&&!restored.isError)render(restored,null)}catch(error){setStatus('已保存为首选主图，尚未审核或发布；候选状态稍后刷新。',false)}}finally{setBusy(false)}});
})();
</script></main></body></html>`
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

function sanitizeMerchantText(value) {
  return value
    .replace(/https?:\/\/[^\s)]+/giu, '相关链接')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu, '相关记录')
    .replace(/\bsha256:[0-9a-f]{64}\b/giu, '相关记录')
    .replace(/\b(?:task|prod|content|request|trace|fixture-store|account)[_-][A-Za-z0-9-]{4,}\b/giu, '相关记录')
    .replace(/\b(?:billing|catalog|content|publish|subscription|workspace|platform)\.[a-z][A-Za-z0-9_-]+\b/gu, '当前步骤')
}

function sanitizeMerchantAction(value) {
  const sanitized = sanitizeMerchantText(value)
    .replace(/\b(?:product|task|account|workspace|content|campaign|batch)[_-]?id\b/giu, '相关信息')
    .replace(/\b(?:id|hash|revision|trace)\s*[:：#]?\s*[A-Za-z0-9_-]{6,}/giu, '相关记录')
    .replace(/(?:调用|使用|执行)\s+当前步骤/gu, '继续当前步骤')
    .replace(/请(?:先)?(?:调用|使用|执行|继续)\s+当前步骤(?:\s+.+)?$/u, '请继续当前步骤')
    .trim()
  return /^(?:请)?继续当前步骤/u.test(sanitized) ? '继续当前步骤' : sanitized
}

const MERCHANT_ACTION_LABELS = {
  'catalog.search': '选择平台、店铺和商品',
  'platform.connect': '连接店铺',
  'subscription.change': '调整店铺额度',
  'billing.recharge.create': '创建充值订单',
  'task.create': '创建营销任务',
  'task.resume': '恢复任务并回答问题',
  'asset.facts.confirm': '确认商品事实',
  'content.generate': '生成内容',
  'content.export': '导出交付包',
  'publish.prepare': '查看发布预览',
  'publish.confirm': '确认发布',
}

function merchantActionLabel(value) {
  if (typeof value !== 'string') return undefined
  const match = value.match(/\b(?:catalog|platform|subscription|billing|task|asset|content|publish)\.[a-z][A-Za-z0-9_-]+\b/u)
  return match ? MERCHANT_ACTION_LABELS[match[0]] : undefined
}

function merchantNextActionLabel(value) {
  if (typeof value === 'string') return merchantActionLabel(value) ?? sanitizeMerchantAction(value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return merchantActionLabel(value.tool ?? value.method) ?? sanitizeMerchantAction(String(value.label ?? value.title ?? value.description ?? ''))
}

function merchantPlatformLabel(value) {
  return ({ jd: '京东', taobao: '淘宝', tmall: '天猫', pinduoduo: '拼多多', xiaohongshu: '小红书', douyin: '抖音' })[String(value ?? '').toLowerCase()] ?? String(value ?? '')
}

function detailDecisionVersions(method, result) {
  if (method === 'content.generate') {
    if (result && typeof result === 'object' && !Array.isArray(result) && result.body && typeof result.body === 'object' && !Array.isArray(result.body)) return [result]
    return []
  }
  if (method !== 'content.versions') return []
  if (Array.isArray(result)) return result.filter(item => item && typeof item === 'object' && !Array.isArray(item) && item.body && typeof item.body === 'object' && !Array.isArray(item.body))
  if (result && typeof result === 'object' && !Array.isArray(result) && Array.isArray(result.items)) {
    return result.items.filter(item => item && typeof item === 'object' && !Array.isArray(item) && item.body && typeof item.body === 'object' && !Array.isArray(item.body))
  }
  return []
}

function detailDecisionBlocker(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return undefined
  const evidence = contract.evidence && typeof contract.evidence === 'object' && !Array.isArray(contract.evidence) ? contract.evidence : {}
  if (evidence.status === 'missing' && contract.optional !== true) return {
    reason: '缺少可验证证据，这一屏暂不能进入正式详情。',
    next: '补齐与宣称匹配的商品事实和视觉证据后，重新生成并审核。',
  }
  if (evidence.status === 'conflict') return {
    reason: '宣称与当前证据存在冲突，这一屏暂不能进入正式详情。',
    next: '先核对并统一商品事实与证据，再重新生成并审核。',
  }
  if (evidence.status === 'expired') return {
    reason: '宣称证据已过期，这一屏暂不能进入正式详情。',
    next: '更新有效证据后，重新生成并审核。',
  }
  const claim = contract.claim && typeof contract.claim === 'object' && !Array.isArray(contract.claim) ? contract.claim : {}
  const claimSourceIds = Array.isArray(claim.factSourceIds) ? claim.factSourceIds.filter(sourceId => typeof sourceId === 'string' && sourceId.trim()) : []
  const evidenceSourceIds = Array.isArray(evidence.sourceIds) ? evidence.sourceIds.filter(sourceId => typeof sourceId === 'string' && sourceId.trim()) : []
  const verifiedEvidenceComplete = evidence.status === 'verified'
    && typeof claim.text === 'string' && Boolean(claim.text.trim())
    && claimSourceIds.length > 0
    && evidenceSourceIds.length > 0
    && evidenceSourceIds.every(sourceId => claimSourceIds.includes(sourceId))
  if (!verifiedEvidenceComplete) return {
    reason: '证据合同不完整或状态未核验，这一屏暂不能进入正式详情。',
    next: '补齐宣称与可追溯证据的一致绑定后，重新审核。',
  }
  return undefined
}

function detailDecisionSummary(method, result) {
  const versions = detailDecisionVersions(method, result)
  if (!versions.length) {
    if (method === 'content.versions' && (Array.isArray(result) || result && typeof result === 'object' && !Array.isArray(result) && Array.isArray(result.items))) return '暂未找到可展示的详情内容版本。'
    return undefined
  }
  return versions.map((version, versionIndex) => {
    const body = version.body
    const title = typeof body.title === 'string' && body.title.trim() ? sanitizeMerchantText(body.title.trim()) : '未命名商品详情'
    const modules = Array.isArray(body.modules) ? body.modules : []
    const visibleModules = modules.filter(module => {
      if (!module || typeof module !== 'object' || Array.isArray(module)) return false
      const contract = module.decisionContract
      const evidence = contract && typeof contract === 'object' && !Array.isArray(contract) && contract.evidence && typeof contract.evidence === 'object' && !Array.isArray(contract.evidence) ? contract.evidence : undefined
      return !(contract?.optional === true && evidence?.status === 'missing')
    })
    const moduleLines = visibleModules.flatMap((module, index) => {
      const contract = module.decisionContract && typeof module.decisionContract === 'object' && !Array.isArray(module.decisionContract) ? module.decisionContract : undefined
      const moduleTitle = typeof module.title === 'string' && module.title.trim() ? sanitizeMerchantText(module.title.trim()) : `详情模块 ${index + 1}`
      if (!contract) return [
        `${index + 1}. ${moduleTitle}（legacy_review_required）`,
        '阻断原因：历史模块缺少买家问题和证据决策合同，原正文未作为事实展示。',
        '下一步：补齐决策合同和可追溯证据后，重新审核该模块。',
      ]
      const buyerQuestion = typeof contract.buyerQuestion === 'string' && contract.buyerQuestion.trim()
        ? sanitizeMerchantText(contract.buyerQuestion.trim())
        : '这一屏的买家问题尚未完整说明。'
      const blocker = detailDecisionBlocker(contract)
      if (blocker) return [`${index + 1}. ${moduleTitle}（已阻断）`, `买家问题：${buyerQuestion}`, `阻断原因：${blocker.reason}`, `下一步：${blocker.next}`]
      const claim = contract.claim
      return [`${index + 1}. ${moduleTitle}`, `买家问题：${buyerQuestion}`, `正文：${sanitizeMerchantText(claim.text.trim())}`]
    })
    const verifiedClaims = visibleModules.flatMap(module => {
      const contract = module?.decisionContract
      if (!contract || typeof contract !== 'object' || Array.isArray(contract) || detailDecisionBlocker(contract)) return []
      return [sanitizeMerchantText(contract.claim.text.trim())]
    })
    return [
      ...(versions.length > 1 ? [`第 ${versionIndex + 1} 版`] : []),
      `标题：${title}`,
      '状态：仅展示当前内容版本中有完整证据绑定的宣称，不代表内容已批准或已发布。',
      '已验证宣称：',
      ...(verifiedClaims.length ? verifiedClaims.map(point => `- ${point}`) : ['- 暂无可展示的已验证宣称']),
      '详情模块：',
      ...(moduleLines.length ? moduleLines : ['暂无可展示模块。']),
    ].join('\n')
  }).join('\n\n')
}

function userFacingToolText(method, result) {
  const decisionSummary = detailDecisionSummary(method, result)
  if (decisionSummary) return decisionSummary
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return method === 'content.export' ? '导出已准备好。' : '服务端已返回响应，状态尚未确认。请查看当前任务状态后再决定下一步。'
  }
  const merchantStatus = result.merchant_status && typeof result.merchant_status === 'object' ? result.merchant_status : undefined
  if (merchantStatus) {
    const label = typeof merchantStatus.label === 'string' ? merchantStatus.label : '需要查看状态'
    const next = merchantStatus.next_action && typeof merchantStatus.next_action === 'object' && typeof merchantStatus.next_action.label === 'string' ? merchantStatus.next_action.label : ''
    const progress = merchantStatus.progress && typeof merchantStatus.progress === 'object' && typeof merchantStatus.progress.label === 'string' ? `进度：${merchantStatus.progress.label}` : ''
    const caution = merchantStatus.recovery?.reconciliation_required === true ? '平台最终回执尚未确认，不要重复提交。' : ''
    return [`${label}。`, progress, caution, next ? `下一步：${next}` : ''].filter(Boolean).join('\n')
  }
  if ((method === 'merchant.start' || method === 'workspace.health') && result.conversation_state) {
    const summary = typeof result.completed_summary === 'string' ? result.completed_summary.trim() : ''
    const question = typeof result.question === 'string' ? result.question.trim() : ''
    return [summary, question].filter(Boolean).join('\n')
  }
  if (method === 'catalog.image.get' && result.candidate_state) {
    if (result.candidate_state.presentation === 'component') return '主图候选已准备好。'
    if (typeof result.question === 'string' && result.question.trim()) return result.question.trim()
    return typeof result.completed_summary === 'string' && result.completed_summary.trim()
      ? result.completed_summary.trim()
      : '主图候选仍在自动检查，通过后会继续，无需操作。'
  }
  const explicitContext = method === 'merchant.start' && result.ui && typeof result.ui === 'object' && !Array.isArray(result.ui)
    ? result.ui.recognized_context
    : undefined
  if (explicitContext?.platform) {
    const nextStep = typeof result.ui?.next_step?.label === 'string' ? sanitizeMerchantAction(result.ui.next_step.label) : ''
    const goal = typeof explicitContext.goal === 'string' && explicitContext.goal ? `，目标：${sanitizeMerchantAction(explicitContext.goal)}` : ''
    const attachments = Number.isInteger(explicitContext.attachment_count) && explicitContext.attachment_count > 0 ? `，附件：${explicitContext.attachment_count} 个` : ''
    return [`已识别平台：${merchantPlatformLabel(explicitContext.platform)}${goal}${attachments}。`, nextStep ? `下一步：${nextStep}` : ''].filter(Boolean).join('\n')
  }
  const cards = Array.isArray(result.action_cards) ? result.action_cards : []
  const actions = Array.isArray(result.next_actions)
    ? result.next_actions.map(merchantNextActionLabel).filter(Boolean)
    : []
  const cardLabels = cards
    .map(card => card && typeof card === 'object' ? merchantActionLabel(card.tool ?? card.method) ?? (typeof card.label === 'string' ? card.label.trim() : '') : '')
    .map(label => label === '继续当前步骤' ? '继续当前步骤' : sanitizeMerchantAction(label))
    .filter(Boolean)
  // Codex App 对话层只给一个主行动；其余动作仍保留在结构化卡片中供宿主按上下文呈现。
  const uniqueActions = [...new Set([...cardLabels, ...actions])].slice(0, 1)
  const summary = typeof result.summary === 'string' && result.summary.trim()
    ? sanitizeMerchantText(result.summary.trim())
    : typeof result.message === 'string' && result.message.trim()
      ? sanitizeMerchantText(result.message.trim())
      : result.status === 'needs_input' ? '还需要补充信息。' : (Array.isArray(result.images) && result.images.length > 0) || ['ok', 'success', 'succeeded', 'completed', 'complete', 'ready', 'published', 'active'].includes(String(result.status ?? '').toLowerCase()) ? '操作已完成。' : '服务端已返回响应，状态尚未确认。请查看当前任务状态后再决定下一步。'
  const pending = ['queued', 'generating', 'processing'].includes(result.state) || ['queued', 'running', 'pending'].includes(result.status)
  const pendingSummary = pending ? '请求已进入平台中转队列，尚未产生可交付内容。' : summary
  const attachmentHint = Array.isArray(result.images) && result.images.length
    ? `已生成 ${result.images.length} 个图片附件。`
    : ''
  return [pendingSummary, attachmentHint, uniqueActions.length ? `下一步：${uniqueActions.join('；')}` : ''].filter(Boolean).join('\n')
}

function userFacingErrorText(code, details) {
  const retryable = new Set(['API_STARTING', 'API_UNAVAILABLE', 'RATE_LIMITED', 'MCP_GATEWAY_ERROR'])
  if (code === 'INTERACTIVE_WRITE_DISABLED' || code === 'INTERACTIVE_CONFIRMATION_REQUIRED') {
    return '这一步需要你的明确确认。确认后可以继续，未执行任何写操作。'
  }
  if (code === 'RECHARGE_REQUIRED' || code === 'BILLING_INSUFFICIENT_BALANCE') {
    return '余额不足，请先充值'
  }
  if (code === 'FACTS_CONFIRMATION_REQUIRED') return '请先确认商品事实'
  if (code === 'ASSET_PARSE_TIMEOUT') return '图片已保存并通过自动安全检查，但商品信息读取超时。要我重新读取一次吗？'
  if (code === 'ASSET_PARSE_FAILED' || code === 'ASSET_PARSE_EMPTY' || code === 'ASSET_PARSE_ATTEMPTS_EXHAUSTED') {
    return '图片已保存并通过自动安全检查，但没有读出可靠的商品信息。请先告诉我商品名称；我会继续使用当前图片记录你的确认，无需重新连接工作区或重复上传。'
  }
  if (code === 'PERMISSION_DENIED') return '当前账号没有执行这一步的权限。任务和已有内容已保留。'
  if (code === 'MCP_AUTH_REQUIRED') return '当前服务配置尚未就绪。任务和已有内容已保留，没有扣费或发布；平台恢复后可继续处理。'
  if (code === 'MODEL_RELAY_EVIDENCE_REQUIRED') {
    const missing = Array.isArray(details?.missing) ? details.missing : []
    if (missing.includes('cost_cny') || missing.includes('settlement')) return '平台正在核对本次生成记录，暂时不能继续。没有生成新内容、扣费或发布；当前任务和已有产物已保留，核对完成后可继续。'
    return '平台暂时无法确认本次生成结果，已安全停止。当前任务和已有产物已保留，没有重复调用、扣费或发布；平台恢复后可继续。'
  }
  if (code === 'MCP_HTTPS_REQUIRED') return '当前服务的安全连接尚未就绪。任务和已有内容已保留，没有扣费或发布；平台恢复后可继续处理。'
  if (code === 'MCP_STRICT_AUTH_REQUIRED') return '当前服务的安全鉴权尚未就绪。任务和已有内容已保留，没有扣费或发布；平台恢复后可继续处理。'
  if (code === 'MCP_GATEWAY_ERROR' && typeof details?.safe_message === 'string') return details.safe_message
  if (code === 'MCP_GATEWAY_ERROR' && typeof details?.config_message === 'string') return details.config_message
  if (code === 'MCP_GATEWAY_ERROR' && details?.export_signature_invalid === true) return '导出文件校验失败，未返回文件。请重新生成导出。'
  if (code === 'MCP_GATEWAY_ERROR' && details?.operation_status === 'unknown') {
    return '服务连接中断，尚未确认操作是否完成。请先查看任务状态，再决定是否重试。'
  }
  if (code === 'BRAND_VISUAL_RULES_BLOCKED') {
    const count = Array.isArray(details?.issues) ? details.issues.length : 0
    return count ? `内容被品牌规则拦截（${count} 项）。请先修正标记的问题，再重试。` : '内容被品牌规则拦截。请先修正规则问题，再重试。'
  }
  return retryable.has(code) || code === 'MCP_AUTH_REQUIRED' ? '服务暂时不可用，未确认操作是否完成。请稍后重试；如仍失败，再检查工作区连接。' : '这一步没有完成，当前任务和已有产物已保留。请根据提示修正后再继续。'
}

function toolErrorPresentation(method, args, code, details) {
  if (method === 'platform.connect' && code === 'NOT_CONFIGURED') {
    const platform = merchantPlatformLabel(args?.platform) || '当前平台'
    return {
      text: `当前${platform}官方连接尚未启用，暂时无法读取店铺。你的商品图片和确认信息已保留；连接启用后回复“继续”，我会从当前步骤接着处理。`,
      recovery: {
        state: 'service_unavailable',
        user_action_required: false,
        preserved: ['uploaded_assets', 'confirmed_facts', 'rights_confirmation'],
        resume_message: '继续',
      },
    }
  }
  return { text: userFacingErrorText(code, details) }
}

function safeErrorDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined
  const safe = {}
  const sanitize = (value, depth = 0) => {
    if (depth > 2) return undefined
    if (typeof value === 'string') {
      return value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]').replace(/(?:api[_-]?key|token|secret|cookie|authorization)\s*[:=]\s*[^,;\s]+/giu, '$1=[REDACTED]').replace(/\/(?:Users|home|private|var)\/[^\s]+/gu, '[PATH_REDACTED]').slice(0, 240)
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value
    if (Array.isArray(value)) return value.slice(0, 8).map(item => sanitize(item, depth + 1)).filter(item => item !== undefined)
    if (value && typeof value === 'object') {
      const nested = {}
      for (const [key, item] of Object.entries(value)) {
        if (['code', 'field', 'message', 'status', 'state', 'retry_after_seconds', 'request_id', 'operation_status', 'issues', 'missing', 'required', 'next_actions', 'retryable', 'attempts', 'asset_id', 'asset_persisted'].includes(key)) {
          const sanitized = sanitize(item, depth + 1)
          if (sanitized !== undefined) nested[key] = sanitized
        }
      }
      return Object.keys(nested).length ? nested : undefined
    }
    return undefined
  }
  for (const key of ['issues', 'missing', 'required', 'status', 'state', 'retry_after_seconds', 'request_id', 'operation_status', 'next_actions', 'retryable', 'attempts', 'asset_id', 'asset_persisted']) {
    const value = sanitize(details[key])
    if (value !== undefined) safe[key] = value
  }
  return Object.keys(safe).length ? safe : undefined
}

function deploymentEnvironment() {
  return (configuredEnv('DEPLOY_ENV') || configuredEnv('NODE_ENV')).toLowerCase()
}

function assertTransportConfiguration() {
  const environment = deploymentEnvironment()
  if (allowsLocalFixtureFallback() && ['production', 'staging', 'preview'].includes(environment)) {
    const error = new Error('fixture fallback is disabled outside local development')
    error.code = 'MCP_FIXTURE_DISABLED'
    throw error
  }
  const endpoint = new URL(baseUrl())
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(endpoint.hostname)
  if (allowsLocalFixtureFallback() && loopback) return
  if (!loopback && endpoint.protocol !== 'https:') {
    const error = new Error('remote MCP endpoint must use HTTPS')
    error.code = 'MCP_HTTPS_REQUIRED'
    throw error
  }
  if (!loopback && !configuredEnv('MERCHANT_MCP_TOKEN')) {
    const error = new Error('remote MCP authentication is not configured')
    error.code = 'MCP_AUTH_REQUIRED'
    throw error
  }
  if (!loopback && configuredEnv('MERCHANT_STRICT_AUTH').toLowerCase() !== 'true') {
    const error = new Error('strict MCP authentication is not enabled')
    error.code = 'MCP_STRICT_AUTH_REQUIRED'
    throw error
  }
}

function assertRelayEvidence(method, result) {
  if (!RELAY_EVIDENCE_METHODS.has(method) || !['production', 'staging', 'preview'].includes(deploymentEnvironment()) || allowsLocalFixtureFallback()) return
  const execution = result && typeof result === 'object' && !Array.isArray(result) && result.execution && typeof result.execution === 'object' ? result.execution : {}
  const pending = result && typeof result === 'object' && !Array.isArray(result) && (['queued', 'generating', 'processing'].includes(result.state) || ['queued', 'running', 'pending'].includes(result.status))
  if (pending) return
  const simulated = execution.simulated === true || result?.simulated === true || result?.mode === 'fixture'
  const providerRequestId = execution.providerRequestId ?? execution.provider_request_id ?? result?.providerRequestId ?? result?.provider_request_id
  const usage = execution.usage ?? result?.usage
  const cost = execution.costCny ?? execution.cost_cny ?? result?.costCny ?? result?.cost_cny
  if (simulated || execution.providerExecuted !== true || typeof providerRequestId !== 'string' || !providerRequestId.trim() || !usage || cost === undefined) {
    const error = new Error('model relay evidence is incomplete; result delivery is blocked')
    error.code = 'MODEL_RELAY_EVIDENCE_REQUIRED'
    error.details = { operation_status: 'blocked', missing: ['provider_request_id', 'usage', 'cost_cny'] }
    throw error
  }
}

function safeStructuredErrorMessage(error, code, details) {
  if (code === 'FACTS_CONFIRMATION_REQUIRED') return '请先确认商品事实'
  if (code === 'PERMISSION_DENIED') return '当前账号没有执行这一步的权限。任务和已有内容已保留。'
  if (code === 'RECHARGE_REQUIRED' || code === 'BILLING_INSUFFICIENT_BALANCE') return '余额不足，请先充值'
  const raw = error instanceof Error ? error.message : ''
  if (/^MERCHANT_(?:MCP_BASE_URL|WORKSPACE_ID) is required/u.test(raw)) return raw
  if (/^content\.export ZIP 文件签名无效$/u.test(raw)) return '导出文件校验失败（ZIP 文件签名无效），未返回文件。请重新生成导出。'
  return userFacingErrorText(code, details)
}

function actionCards(method, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const cards = Array.isArray(result.action_cards) ? result.action_cards.map((card, index) => ({
    ...card,
    id: card.id ?? `${method.replaceAll('.', '-')}-${index + 1}`,
    type: card.type ?? (card.method === 'billing.recharge.create' ? 'recharge' : card.method === 'subscription.change' ? 'upgrade' : 'view'),
    // Tool names and IDs are execution details. Keep them in structuredContent
    // for the model, but never use them as the merchant-facing label.
    label: merchantActionLabel(card.tool ?? card.method) ?? (typeof card.label === 'string' ? sanitizeMerchantAction(card.label) : '查看下一步'),
    tool: card.tool ?? card.method,
    arguments: card.arguments && typeof card.arguments === 'object' && !Array.isArray(card.arguments) ? card.arguments : {},
    required_inputs: Array.isArray(card.required_inputs) ? card.required_inputs : [],
    enabled: card.enabled ?? true,
    reason: sanitizeMerchantText(String(card.reason ?? card.description ?? '')),
    requires_confirmation: card.requires_confirmation ?? card.confirmation === 'interactive_confirmation',
  })) : []
  if (method === 'billing.status' && result.store_capacity && cards.length === 0) {
    for (const [index, label] of (Array.isArray(result.store_capacity.upgrade_actions) ? result.store_capacity.upgrade_actions : []).entries()) {
      cards.push({
        id: `store-capacity-${index + 1}`,
        type: index === 0 ? 'upgrade' : 'store_addon',
        label: merchantActionLabel('subscription.change') ?? label,
        // Store-capacity cards are rendered for merchants. Never point a
        // merchant action at an ops-only tool hidden from tools/list.
        tool: 'subscription.change',
        arguments: {},
        required_inputs: ['to_plan_code', 'billing_cycle', 'channel', 'reason', 'idempotency_key'],
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
  let sanitizedStoreCapacity = result.store_capacity
  if (result.store_capacity && typeof result.store_capacity === 'object' && !Array.isArray(result.store_capacity) && Array.isArray(result.store_capacity.action_cards)) {
    sanitizedStoreCapacity = {
      ...result.store_capacity,
      action_cards: result.store_capacity.action_cards.map(card => card && typeof card === 'object' && !Array.isArray(card) && typeof card.tool === 'string' && card.tool.startsWith('ops.')
        ? { ...card, tool: 'subscription.change', type: 'upgrade', required_inputs: ['to_plan_code', 'billing_cycle', 'channel', 'reason', 'idempotency_key'], requires_confirmation: true }
        : card),
    }
  }
  return cards.length || sanitizedStoreCapacity !== result.store_capacity
    ? { ...result, ...(cards.length ? { action_cards: cards } : {}), ...(sanitizedStoreCapacity !== result.store_capacity ? { store_capacity: sanitizedStoreCapacity } : {}) }
    : result
}

function merchantStartContext(args) {
  const platform = typeof args?.requested_platform === 'string' ? args.requested_platform.trim().toLowerCase() : ''
  const requestedGoal = typeof args?.requested_goal === 'string' ? args.requested_goal.trim() : ''
  const hasAttachmentCount = Number.isInteger(args?.attachment_count) && args.attachment_count >= 0
  const goalLabels = { generate_product_image: '生成商品主图', generate_white_background_image: '生成白底主图' }
  return {
    ...(platform ? { platform } : {}),
    ...(requestedGoal ? { requested_goal: requestedGoal, goal: goalLabels[requestedGoal] ?? sanitizeMerchantAction(requestedGoal) } : {}),
    ...(hasAttachmentCount ? { attachment_count: args.attachment_count } : {}),
  }
}

function merchantContextMetadata(result, explicitContext = {}) {
  const businessUnits = Array.isArray(result?.business_units)
    ? result.business_units
    : Array.isArray(result?.brands) ? result.brands : []
  const stores = Array.isArray(result?.storeDirectory)
    ? result.storeDirectory
    : Array.isArray(result?.stores) ? result.stores : []
  const simulated = result?.execution?.simulated === true || result?.simulated === true || result?.mode === 'fixture'
  const firstAction = Array.isArray(result?.action_cards)
    ? result.action_cards.find(card => card && typeof card === 'object' && card.enabled !== false)
    : undefined
  let nextActionLabel = firstAction
    ? merchantActionLabel(firstAction.tool ?? firstAction.method) ?? (typeof firstAction.label === 'string' ? sanitizeMerchantAction(firstAction.label) : undefined)
    : Array.isArray(result?.next_actions)
      ? result.next_actions.map(merchantNextActionLabel).find(Boolean)
      : undefined
  const selectedPlatform = explicitContext.platform || result?.platform || null
  if (explicitContext.platform && typeof nextActionLabel === 'string' && /选择.*平台|哪个平台|什么平台/u.test(nextActionLabel)) nextActionLabel = `选择${merchantPlatformLabel(explicitContext.platform)}店铺`
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
        platform: { state: selectedPlatform ? 'selected' : 'selectable', value: selectedPlatform },
        store: { state: result?.account_id || result?.accountId ? 'selected' : stores.length ? 'selectable' : 'unknown', value: result?.account_id ?? result?.accountId ?? null, options: stores },
      },
      reset_on_change: {
        business_unit: ['platform', 'account_id', 'product_id', 'selected_product_ids'],
        platform: ['account_id', 'product_id', 'selected_product_ids'],
        account_id: ['product_id', 'selected_product_ids'],
      },
      unresolved: businessUnits.length ? [] : ['品目录尚未由当前 API 提供；不能把品牌或店铺自动当作品'],
    },
    ...(Object.keys(explicitContext).length ? { recognized_context: explicitContext } : {}),
    ...(nextActionLabel ? { next_step: { label: nextActionLabel, description: '只显示当前唯一下一步；执行仍需按当前确认和权限门禁进行。' } } : {}),
  }
}

function firstMerchantAction(result) {
  const canonical = result?.onboarding_v2?.current_step
  if (canonical && typeof canonical === 'object' && !Array.isArray(canonical)) {
    const action = canonical.primary_action
    if (action && typeof action === 'object' && !Array.isArray(action)) return {
      method: typeof action.method === 'string' ? action.method : '',
      label: typeof action.label === 'string' ? sanitizeMerchantAction(action.label) : undefined,
    }
  }
  const card = Array.isArray(result?.action_cards)
    ? result.action_cards.find(item => item && typeof item === 'object' && item.enabled !== false)
    : undefined
  if (card) return {
    method: typeof card.tool === 'string' ? card.tool : typeof card.method === 'string' ? card.method : '',
    label: merchantNextActionLabel(card),
  }
  const action = Array.isArray(result?.next_actions) ? result.next_actions.find(Boolean) : undefined
  if (!action) return { method: '', label: undefined }
  return {
    method: action && typeof action === 'object' && !Array.isArray(action)
      ? typeof action.tool === 'string' ? action.tool : typeof action.method === 'string' ? action.method : ''
      : '',
    label: merchantNextActionLabel(action),
  }
}

function merchantConversationInput(method, stage, actionMethod, explicitContext, storeCount) {
  if (method === 'workspace.health') {
    if (storeCount > 0) return { kind: 'store_or_product_selection', accepts: ['natural_language'] }
    return { kind: 'platform_selection', accepts: ['natural_language'] }
  }
  if (stage === 'automatic_scan') return { kind: 'none', user_action_required: false }
  if (actionMethod === 'platform.connect' || stage === 'bind_store') return { kind: 'platform_selection', accepts: ['natural_language'] }
  if (actionMethod === 'asset.upload' || stage === 'add_assets') return { kind: 'attachment', accepts: ['attachment'] }
  if (actionMethod === 'catalog.search' || stage === 'choose_product') {
    return explicitContext.platform
      ? { kind: 'store_or_product_selection', accepts: ['natural_language'] }
      : { kind: 'platform_store_or_product_selection', accepts: ['natural_language'] }
  }
  return { kind: 'task_goal', accepts: ['natural_language'] }
}

function merchantConversationQuestion(method, stage, expectedInput, explicitContext, result, actionLabel) {
  if (stage === 'automatic_scan' || expectedInput.kind === 'none') return undefined
  if (method === 'workspace.health') {
    if (expectedInput.kind === 'platform_selection') return '你想先连接哪个平台？'
    return '你要处理哪个店铺或商品？'
  }
  if (stage === 'bind_store' || expectedInput.kind === 'platform_selection') return '你想先连接哪个平台？'
  if (stage === 'choose_product') return explicitContext.platform
    ? `你要使用哪个${merchantPlatformLabel(explicitContext.platform)}店铺或商品？`
    : '你要处理哪个店铺或商品？'
  if (stage === 'add_assets' || expectedInput.kind === 'attachment') return '请上传商品图片或资料。'
  if (stage === 'start_content') return '你想为这个商品制作什么内容？'
  if (expectedInput.kind === 'store_or_product_selection') return explicitContext.platform
    ? `你要使用哪个${merchantPlatformLabel(explicitContext.platform)}店铺或商品？`
    : '你要处理哪个店铺或商品？'
  if (expectedInput.kind === 'platform_store_or_product_selection') return '你要处理哪个平台、店铺或商品？'
  const prompt = typeof result?.nextPrompt === 'string' ? sanitizeMerchantAction(result.nextPrompt) : ''
  if (prompt && !/管理员|运营后台|扫描证据|扫描完成/u.test(prompt)) return prompt
  if (actionLabel && !/管理员|运营后台|扫描证据|扫描完成/u.test(actionLabel)) return actionLabel
  return '你想先完成什么营销任务？'
}

function merchantConversationProjection(method, result, args = {}) {
  const explicitContext = method === 'merchant.start' ? merchantStartContext(args) : {}
  const stores = Array.isArray(result?.storeDirectory)
    ? result.storeDirectory
    : Array.isArray(result?.stores) ? result.stores : []
  const canonicalStep = result?.onboarding_v2?.current_step
  const currentStep = canonicalStep && typeof canonicalStep === 'object' && !Array.isArray(canonicalStep)
    ? canonicalStep
    : result?.currentStep && typeof result.currentStep === 'object' && !Array.isArray(result.currentStep)
    ? result.currentStep
    : {}
  const rawStage = String(currentStep.id ?? '').trim().toLowerCase().replaceAll('-', '_')
  const scanning = method === 'merchant.start' && (
    rawStage === 'automatic_scan'
    || String(currentStep.state ?? '').toLowerCase() === 'in_progress' && Number(explicitContext.attachment_count ?? 0) > 0
    || result?.automation?.asset_scan === 'automatic' && Number(explicitContext.attachment_count ?? 0) > 0
  )
  const stage = scanning
    ? 'automatic_scan'
    : rawStage || (method === 'workspace.health' ? stores.length ? 'choose_store_or_product' : 'connect_store' : 'start')
  const workspaceUnavailable = String(result?.workspace?.status ?? '').toLowerCase() === 'disabled'
  const action = firstMerchantAction(result)
  const storeOptions = stores.map((store, index) => {
    const simulated = store.dataMode === 'fixture' || store.state === 'fixture'
    const status = simulated
      ? { label: '演示店铺', explanation: '仅用于演示，不代表真实店铺' }
      : store.state === 'revoked'
        ? { label: '已撤销', explanation: '目前无法读取该店铺商品' }
        : store.state === 'refresh_required'
          ? { label: '需要重新授权', explanation: '目前无法读取该店铺商品' }
          : store.readable
            ? store.writeEnabled
              ? { label: '可读取并发布', explanation: '已授权，可继续选择商品；发布仍需审核和确认' }
              : { label: '可读取', explanation: '可以查看商品，平台发布能力尚未就绪' }
            : { label: '仅有账号记录', explanation: '尚未取得可读取的店铺数据' }
    return {
      id: `store-option-${index + 1}`,
      platform: store.platform ?? null,
      store_name: store.label ?? store.storeName ?? '未命名店铺',
      account_id: store.accountId ?? null,
      status: status.label,
      explanation: status.explanation,
      data_source: simulated ? '演示数据' : store.dataMode === 'official_api' ? '官方 API' : '账号记录',
      selectable: Boolean(store.platform && store.accountId && store.readable && !simulated),
      action: store.platform && store.accountId ? { method: 'catalog.search', arguments: { scope: 'store', platform: store.platform, account_id: store.accountId } } : { method: 'platform.connect', arguments: { platform: store.platform } },
    }
  })
  const expectedInput = workspaceUnavailable
    ? { kind: 'none', user_action_required: false }
    : merchantConversationInput(method, stage, action.method, explicitContext, stores.length)
  const question = workspaceUnavailable
    ? undefined
    : merchantConversationQuestion(method, stage, expectedInput, explicitContext, result, action.label)
  const rawPrimaryAction = canonicalStep && typeof canonicalStep === 'object' && !Array.isArray(canonicalStep) && canonicalStep.primary_action && typeof canonicalStep.primary_action === 'object' && !Array.isArray(canonicalStep.primary_action)
    ? canonicalStep.primary_action
    : undefined
  // Internal scan/operations instructions are not merchant actions. In an
  // automatic scan state the merchant has nothing to do; exposing asset.scan
  // would leak an Ops-only recovery path into the native conversation.
  const merchantActionAllowed = !scanning && action.method !== 'asset.scan' && !/管理员|运营后台|扫描证据/u.test(action.label ?? '')
  const primaryAction = merchantActionAllowed && action.method
    ? {
        method: action.method,
        ...(action.label ? { label: action.label } : {}),
        ...(Array.isArray(rawPrimaryAction?.required_inputs) ? { required_inputs: rawPrimaryAction.required_inputs } : {}),
      }
    : undefined
  const summary = workspaceUnavailable
    ? '当前工作区暂不可用，已有任务和内容已保留。'
    : scanning
      ? '图片已收到，正在自动检查。通过后会等待你的确认再继续生成。'
      : method === 'workspace.health'
        ? stores.length ? `已更新 ${stores.length} 家店铺的连接状态。` : '当前还没有可用店铺。'
        : explicitContext.platform
          ? `已锁定${merchantPlatformLabel(explicitContext.platform)}。`
          : typeof result?.summary === 'string' && result.summary.trim()
            ? sanitizeMerchantText(result.summary.trim())
            : typeof result?.greeting === 'string' && result.greeting.trim()
              ? sanitizeMerchantText(result.greeting.trim())
              : '可以开始了。'
  return {
    conversation_state: {
      stage,
      status: workspaceUnavailable ? 'blocked' : scanning ? 'processing' : question ? 'needs_input' : 'ready',
      ...(explicitContext.platform ? { selected_platform: explicitContext.platform } : {}),
      ...(method === 'workspace.health' ? { connected_store_count: stores.length } : {}),
      ...(storeOptions.length ? { store_options: storeOptions } : {}),
      ...(primaryAction ? { primary_action: primaryAction } : {}),
    },
    completed_summary: summary,
    ...(question ? { question } : {}),
    expected_input: expectedInput,
  }
}

function merchantUiMetadata(method, result, args = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || !MERCHANT_CONTEXT_METADATA_METHODS.has(method)) return result
  if (method === 'merchant.start' || method === 'workspace.health') return merchantConversationProjection(method, result, args)
  const explicitContext = method === 'merchant.start' ? merchantStartContext(args) : {}
  const ui = merchantContextMetadata(result, explicitContext)
  if (method === 'catalog.search') {
    const products = Array.isArray(result.products) ? result.products : Array.isArray(result.items) ? result.items : []
    ui.list = {
      kind: 'products',
      selection: 'multi',
      selection_key: 'product_id',
      empty_state: products.length ? null : '当前范围暂无商品；请先同步或导入商品。',
    }
  }
  if (method === 'merchant.start') {
    const simulated = result?.execution?.simulated === true || result?.simulated === true || result?.mode === 'fixture'
    ui.batch_discovery = [
      { id: 'batch-generate', label: '批量生成商品详情', tool: 'catalog.search', next_tool: 'task.group.create', enabled: true, requires_selection: true },
      { id: 'batch-publish', label: '批量发布已批准商品', tool: 'publish.batch.prepare', enabled: false, requires_selection: true, reason: '先选择商品并完成逐项审核、批准。' },
    ]
    ui.knowledge_status = {
      state: 'ready',
      state_label: '知识已恢复，可继续',
      summary: '当前工作区的规则与知识上下文已由服务端加载；生成时仍会按已选平台、店铺和商品重新校验。',
      scope: { workspace_id: result?.workspace?.id ?? result?.workspace_id ?? null, platform: result?.platform ?? null, account_id: result?.account_id ?? result?.accountId ?? null },
      data_source: simulated ? '演示数据' : '服务端数据',
      blocks_generation: false,
      next_actions: [{ label: '选择平台和店铺商品', tool: 'catalog.search', required_inputs: ['platform', 'account_id', 'product_id'] }],
    }
  }
  return { ...result, ui }
}

function toolUiMetadata(name) {
  if (IMAGE_EDIT_UI_METHODS.has(name)) return {
    ui: { resourceUri: IMAGE_EDIT_UI_URI, prefersBorder: true },
    'openai/outputTemplate': IMAGE_EDIT_UI_URI,
    'openai/toolInvocation/invoking': '正在创建局部编辑候选…',
    'openai/toolInvocation/invoked': '局部编辑候选已更新',
  }
  const resourceUri = TASK_UI_METHODS.get(name)
  if (!resourceUri) return undefined
  const invocation = {
    'creative.directions': ['正在准备创意方向…', '创意方向已准备'],
    'content.diff': ['正在比较内容版本…', '版本差异已准备'],
    'publish.prepare': ['正在准备最终发布确认…', '发布确认已准备'],
    'publish.batch.prepare': ['正在准备批量发布确认…', '批量发布确认已准备'],
  }[name]
  return {
    ui: { resourceUri, prefersBorder: true },
    'openai/outputTemplate': resourceUri,
    'openai/toolInvocation/invoking': invocation[0],
    'openai/toolInvocation/invoked': invocation[1],
  }
}

function toolAnnotations(name) {
  if (READ_ONLY_METHODS.has(name)) return { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  if (name === 'catalog.image.select' || name === 'catalog.image.retry') return { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  if (name === 'content.visual.select') return { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  if (name === 'content.export') return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  return { readOnlyHint: false, destructiveHint: DESTRUCTIVE_WRITE_METHODS.has(name), idempotentHint: false, openWorldHint: DESTRUCTIVE_WRITE_METHODS.has(name) }
}

function toolContent(method, result) {
  result = actionCards(method, result)
  if (method === 'asset.upload') {
    const status = assetScanStatus(result)
    if (status === 'clean' && result?.generation_continuation?.state === 'awaiting_confirmation') return [{ type: 'text', text: '图片已通过自动安全检查。请确认你有权将这张图片用于商业主图并允许 AI 编辑；确认后开始生成吗？' }]
    if (status === 'clean') return [{ type: 'text', text: `图片检查已通过。${result?.next_step && result.next_step !== '继续当前任务' ? `下一步：${sanitizeMerchantAction(result.next_step)}` : ''}`.trim() }]
    if (status === 'blocked') return [{ type: 'text', text: '这张图片暂时不能继续使用。素材已安全保留；平台会在你重新提交图片时自动复检，无需人工处理或提交扫描结果。' }]
    return [{ type: 'text', text: '图片已收到，正在自动检查。检查通过后会等待你的确认再生成。' }]
  }
  if (method === 'content.export') return materializeExportArtifact(result).content
  const hasImages = (method.startsWith('catalog.image.') || method === 'creative.preview' || method === 'multimodal.image.edit') && Array.isArray(result?.images)
  // Keep the human-readable text small. Sending the full base64 payload both in
  // text and as image blocks makes Codex render the tool result as an oversized
  // text response and can hide the actual image attachments.
  // A component URL can be blocked by a desktop webview (notably loopback HTTP
  // during local acceptance). Keep the clean candidate as a native MCP image
  // block as well. The component still owns selection; no local artifact is
  // created for this path and the model only receives the normal image block.
  const imageFiles = hasImages ? materializeImageFiles(result.images) : []
  const textResult = hasImages
    ? { ...result, images: result.images.map((image, index) => typeof image === 'string' ? `[image attachment ${index + 1}]` : image), ...(imageFiles.length ? { image_files: imageFiles, image_markdown: imageFiles.map((file, index) => `![商品主图${index + 1}](${file})`).join('\n') } : {}) }
    : result
  const content = [{ type: 'text', text: userFacingToolText(method, textResult) }]
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

function imageEditUiHtml() {
  return readFileSync(new URL('../ui/image-local-edit.html', import.meta.url), 'utf8')
}

function imageResourceDomains() {
  const configured = configuredEnv('MERCHANT_ASSET_RESOURCE_DOMAINS')
  const candidates = [configuredEnv('MERCHANT_MCP_BASE_URL'), ...(configured
    ? (() => {
        try {
          const parsed = JSON.parse(configured)
          return Array.isArray(parsed) ? parsed : []
        } catch {
          return configured.split(',')
        }
      })()
    : [])]
  return [...new Set(candidates.flatMap(value => {
    if (typeof value !== 'string' || !value.trim()) return []
    try {
      const url = new URL(value.trim())
      const localHttp = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
      return url.protocol === 'https:' || localHttp ? [url.origin] : []
    } catch {
      return []
    }
  }))]
}

function privateCandidateSelectionTickets(rawResult, result) {
  if (!rawResult || typeof rawResult !== 'object' || Array.isArray(rawResult) || !Array.isArray(rawResult.selection_tickets)) return []
  const visibleRefs = new Set(Array.isArray(result?.selection_request?.candidates)
    ? result.selection_request.candidates.map(candidate => candidate?.visual_ref).filter(value => typeof value === 'string' && value)
    : [])
  const hashes = /^[a-f0-9]{64}$/u
  const tickets = new Map()
  for (const value of rawResult.selection_tickets) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const visualRef = typeof value.visual_ref === 'string' ? value.visual_ref.trim() : ''
    const nonceHash = typeof value.nonce_hash === 'string' ? value.nonce_hash.trim() : ''
    const intentHash = typeof value.intent_hash === 'string' ? value.intent_hash.trim() : ''
    const expiresAt = typeof value.expires_at === 'string' ? value.expires_at.trim() : ''
    if (!visibleRefs.has(visualRef) || !hashes.test(nonceHash) || !hashes.test(intentHash) || !expiresAt || !Number.isFinite(Date.parse(expiresAt)) || tickets.has(visualRef)) continue
    tickets.set(visualRef, { visual_ref: visualRef, nonce_hash: nonceHash, intent_hash: intentHash, expires_at: expiresAt })
  }
  return [...tickets.values()]
}

function toolResultUiMetadata(name, result, selectionTickets = []) {
  const candidateState = result?.candidate_state
  const selectionCandidates = Array.isArray(result?.selection_request?.candidates) ? result.selection_request.candidates : []
  const readyChoice = name === 'catalog.image.get'
    && candidateState?.state === 'ready'
    && (candidateState?.presentation === 'component' || candidateState?.presentation === 'native_image')
    && candidateState?.candidate_count > 0
    && selectionCandidates.length > 0
  if (readyChoice) return {
    ui: { resourceUri: IMAGE_CANDIDATE_CHOICE_UI_URI, prefersBorder: true },
    'openai/outputTemplate': IMAGE_CANDIDATE_CHOICE_UI_URI,
    'openai/widgetAccessible': true,
    'openai/toolInvocation/invoked': '主图候选已准备',
    'merchant/candidateImages': Array.isArray(result.image_urls) ? result.image_urls : [],
    ...(Array.isArray(result.images) && result.images.length ? { 'merchant/candidateImageFallbacks': result.images } : {}),
    ...(selectionTickets.length ? { 'merchant/candidateSelectionTickets': selectionTickets } : {}),
  }
  if (IMAGE_EDIT_UI_METHODS.has(name)) return { ui: { resourceUri: IMAGE_EDIT_UI_URI } }
  if (RECHARGE_UI_METHODS.has(name)) return { ui: { resourceUri: RECHARGE_UI_URI } }
  if (TASK_UI_METHODS.has(name)) return { ui: { resourceUri: TASK_UI_METHODS.get(name) } }
  return undefined
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
  const environment = deploymentEnvironment()
  if (['production', 'staging', 'preview'].includes(environment)) return interactiveWriteUntil > Date.now()
  return configuredEnv('MERCHANT_MCP_WRITE_ENABLED').toLowerCase() === 'true' || interactiveWriteUntil > Date.now()
}

async function confirmInteractiveWrites(args) {
  if (args.confirmation !== 'I_CONFIRM_INTERACTIVE_WRITES') {
    const error = new Error('必须在当前交互会话明确确认写操作')
    error.code = 'INTERACTIVE_CONFIRMATION_REQUIRED'
    throw error
  }
  interactiveWriteUntil = Date.now() + INTERACTIVE_WRITE_TTL_MS
  const remoteTicketRequired = ['production', 'staging', 'preview'].includes(deploymentEnvironment()) || Boolean(configuredEnv('MERCHANT_MCP_TOKEN'))
  let remoteConfirmation
  if (remoteTicketRequired) remoteConfirmation = await callRemote('workspace.interactive.confirm', args)
  return {
    enabled: true,
    expires_at: remoteConfirmation?.ticket?.expires_at ?? new Date(interactiveWriteUntil).toISOString(),
    scope: remoteConfirmation?.scope ?? 'current_plugin_process',
    automation: 'read_only',
    ...(remoteConfirmation?.ticket ? { ticket: remoteConfirmation.ticket } : {}),
  }
}

function baseUrl() {
  const value = configuredEnv('MERCHANT_MCP_BASE_URL') || (allowsLocalFixtureFallback() ? 'http://127.0.0.1:8790' : '')
  if (!value) throw new Error('MERCHANT_MCP_BASE_URL is required; refusing to use the local fixture fallback unless MERCHANT_ALLOW_FIXTURE_FALLBACK=true')
  const parsed = new URL(value)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('MERCHANT_MCP_BASE_URL must use http or https')
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') throw new Error('MERCHANT_MCP_BASE_URL must use https in production')
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '' && parsed.pathname !== '/')) throw new Error('MERCHANT_MCP_BASE_URL must be a root origin without credentials, path, query, or fragment')
  return `${parsed.origin}/mcp`
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
  if (method === 'merchant.start') {
    const context = merchantStartContext(params)
    const normalized = {
      ...(context.platform ? { requested_platform: context.platform } : {}),
      ...(context.requested_goal ? { requested_goal: context.requested_goal } : {}),
      ...(Number.isInteger(context.attachment_count) ? { attachment_count: String(context.attachment_count) } : {}),
    }
    const suppliedKey = typeof params.idempotency_key === 'string' ? params.idempotency_key.trim() : ''
    const generatedKey = `merchant-start-${createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 32)}`
    return { ...normalized, idempotency_key: suppliedKey || generatedKey }
  }
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
  assertTransportConfiguration()
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
  if (!token && !allowsLocalFixtureFallback() && new URL(baseUrl()).protocol === 'https:') {
    const error = new Error('MCP authentication is not configured')
    error.code = 'MCP_AUTH_REQUIRED'
    throw error
  }
  const ruleApprovalToken = process.env.MERCHANT_RULE_APPROVAL_TOKEN?.trim()
  if ((method === 'rule.publish' || method === 'rule.status') && ruleApprovalToken && !/^\$\{[^}]+\}$/u.test(ruleApprovalToken)) headers['x-rule-approval-token'] = ruleApprovalToken
  if (method === 'publish.confirm' || method === 'content.generate' || method === 'content.visual.select' || method === 'catalog.image.select' || method === 'platform.media.spec.create' || method === 'platform.media.spec.update' || method === 'platform.media.spec.approve' || method === 'platform.media.spec.expire' || method === 'campaign.batch.pause' || method === 'campaign.batch.resume' || method === 'campaign.batch.retry_failed') {
    headers['idempotency-key'] = typeof params.idempotency_key === 'string' && params.idempotency_key.trim()
      ? params.idempotency_key.trim()
      : idempotencyKey(method, params)
  }

  // Content and image providers legitimately take 90-120 seconds. Keep the
  // desktop bridge alive longer than the provider boundary so it can return
  // the settled result instead of reporting a false timeout after billing.
  const timeoutMs = Number(process.env.MERCHANT_MCP_TIMEOUT_MS ?? 180000)
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
          redirect: 'error',
          headers,
          body: JSON.stringify({ jsonrpc: '2.0', id: `${Date.now()}-${Math.random()}`, method, params: { ...params, ...(scopedWorkspaceId ? { workspace_id: scopedWorkspaceId } : {}) } }),
          signal: controller.signal,
        })
        const payload = await responseJsonWithLimit(response)
        const retrySafe = READ_ONLY_METHODS.has(method) || headers['idempotency-key'] !== undefined
        const transient = response.status === 429 || ((response.status === 502 || response.status === 503 || response.status === 504) && retrySafe)
        if ((!response.ok || !payload || payload.error) && (!transient || attempt === maxAttempts)) {
          const error = payload?.error ?? {
            code: response.status === 401 ? 'MCP_AUTH_REQUIRED' : response.status === 403 ? 'PERMISSION_DENIED' : `HTTP_${response.status}`,
            message: response.status === 401
              ? 'MCP gateway authentication failed'
              : response.status === 403
                ? 'MCP gateway authorization denied'
                : `MCP gateway returned HTTP ${response.status}`,
          }
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
        assertRelayEvidence(method, result)
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

function assetScanStatus(value) {
  const status = String(value?.scanStatus ?? value?.scan_status ?? '').trim().toLowerCase()
  if (status === 'clean' || status === 'blocked' || status === 'quarantined') return status
  return 'quarantined'
}

function safeImageSubjectLabel(result, job, candidate) {
  const values = [
    candidate?.subjectLabel, candidate?.subject_label,
    job?.subjectLabel, job?.subject_label, job?.productTitle, job?.product_title,
    result?.product?.title, result?.product?.name,
  ]
  for (const value of values) {
    if (typeof value !== 'string') continue
    const normalized = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f\p{Cf}]/gu, '').trim().slice(0, 80)
    if (normalized) return normalized
  }
  return '商品主体'
}

function merchantImageCandidateStructuredContent(method, result, args = {}) {
  if (method !== 'catalog.image.get' || !result || typeof result !== 'object' || Array.isArray(result)) return result
  const job = result.job && typeof result.job === 'object' && !Array.isArray(result.job) ? result.job : {}
  const candidates = Array.isArray(job.candidates) ? [...job.candidates].filter(candidate => candidate && typeof candidate === 'object' && !Array.isArray(candidate)).sort((left, right) => Number(left.ordinal ?? 0) - Number(right.ordinal ?? 0)) : []
  const rawImages = Array.isArray(result.images)
    ? result.images.filter(image => typeof image === 'string' && /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/iu.test(image))
    : []
  const rawImageUrls = Array.isArray(result.image_urls)
    ? result.image_urls.filter(image => typeof image === 'string' && (/^https:\/\//iu.test(image) || /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//iu.test(image)))
    : []
  const archived = String(job.archiveState ?? job.archive_state ?? '').toLowerCase() === 'archived'
  const requestedVisualRef = typeof args?.visual_ref === 'string' ? args.visual_ref.trim() : ''
  const requestedCandidate = requestedVisualRef
    ? candidates.find(candidate => candidate.visualRef === requestedVisualRef || candidate.visual_ref === requestedVisualRef)
    : undefined
  const visibleCandidates = requestedVisualRef ? (requestedCandidate ? [requestedCandidate] : []) : candidates
  const selectionJobId = typeof result.job_id === 'string' && result.job_id.trim()
    ? result.job_id.trim()
    : typeof job.jobId === 'string' ? job.jobId.trim() : ''
  const expectedRevision = Number(job.revision)
  const requestedCandidateClean = Boolean(requestedCandidate) && String(requestedCandidate.scanStatus ?? requestedCandidate.scan_status ?? '').toLowerCase() === 'clean'
  const allCandidatesClean = candidates.length === rawImages.length && candidates.length > 0 && candidates.every(candidate => String(candidate.scanStatus ?? candidate.scan_status ?? '').toLowerCase() === 'clean')
  const deliverable = archived && rawImages.length > 0 && (requestedVisualRef ? rawImages.length === 1 && requestedCandidateClean : allCandidatesClean)
  const images = deliverable ? rawImages : []
  const imageUrls = deliverable && rawImageUrls.length === images.length ? rawImageUrls : []
  const multiple = images.length > 1
  const errorCode = typeof job.errorCode === 'string' ? job.errorCode : typeof job.error_code === 'string' ? job.error_code : ''
  const reconciliationRequired = Boolean(job.reconciliationRequired ?? job.reconciliation_required) || errorCode === 'IMAGE_ARTIFACT_RECONCILIATION_REQUIRED'
  const rawJobState = String(job.state ?? '').toLowerCase()
  const candidateLifecycle = deliverable
    ? 'ready'
    : reconciliationRequired
      ? 'unknown'
      : rawJobState === 'failed'
        ? 'failed'
        : rawJobState === 'queued'
          ? 'queued'
          : 'processing'
  const nextAction = candidateLifecycle === 'ready'
    ? { type: 'select', label: '选择主图', allowed: true }
    : candidateLifecycle === 'failed'
      ? { type: 'regenerate_in_conversation', label: '回到对话重新生成', allowed: true }
      : candidateLifecycle === 'unknown'
        ? { type: 'refresh', label: '查询结果', allowed: true }
        : { type: 'wait', label: '系统自动继续', allowed: false }
  const recoveryPresentation = (candidateLifecycle === 'failed' || candidateLifecycle === 'unknown') && selectionJobId
    ? 'component_recovery'
    : (candidateLifecycle === 'queued' || candidateLifecycle === 'processing') && selectionJobId
      ? 'component_progress'
      : 'native_status'
  return {
    candidate_state: {
      state: candidateLifecycle,
      archive_state: archived ? 'archived' : rawJobState === 'queued' ? 'pending' : 'processing',
      scan_status: deliverable ? 'clean' : rawJobState === 'queued' ? 'pending' : 'processing',
      candidate_count: images.length,
      presentation: imageUrls.length ? 'component' : images.length ? 'native_image' : recoveryPresentation,
      next_action: nextAction,
      recovery: {
        retryable: candidateLifecycle === 'failed',
        reconciliation_required: reconciliationRequired,
      },
    },
    completed_summary: multiple
      ? `已准备 ${images.length} 张通过自动检查的主图候选。`
      : images.length === 1
        ? '主图候选已准备好。'
        : candidateLifecycle === 'failed'
          ? '本次主图生成未完成，可以回到对话重新生成。'
          : candidateLifecycle === 'unknown'
            ? '图片结果尚未确认，请先查询任务状态，不会自动重复生成。'
            : candidateLifecycle === 'queued'
              ? '图片任务已排队，完成后会继续，无需重复提交。'
            : '主图候选仍在自动检查，通过后会继续，无需操作。',
    ...(images.length
      ? { question: multiple ? '请选择一张作为主图。' : '要使用这张作为主图吗？' }
      : candidateLifecycle === 'failed'
        ? { question: '要回到对话重新生成主图吗？' }
        : candidateLifecycle === 'unknown'
          ? { question: '要先查询图片结果吗？' }
          : {}),
    expected_input: images.length
      ? { kind: 'main_image_selection', accepts: ['component_selection', 'natural_language'], selection_count: 1 }
      : candidateLifecycle === 'failed' || candidateLifecycle === 'unknown'
        ? { kind: 'component_action', action: nextAction.type, user_action_required: true }
        : { kind: 'none', user_action_required: false },
    ...(deliverable && selectionJobId && Number.isSafeInteger(expectedRevision) && expectedRevision > 0 ? {
      selection_request: {
        job_id: selectionJobId,
        expected_revision: String(expectedRevision),
        ...(job.preferredCandidate && typeof job.preferredCandidate.visualRef === 'string' ? { selected_visual_ref: job.preferredCandidate.visualRef } : {}),
        candidates: visibleCandidates.map(candidate => ({
          ordinal: Number(candidate.ordinal),
          visual_ref: String(candidate.visualRef ?? candidate.visual_ref ?? ''),
          selectable: String(candidate.scanStatus ?? candidate.scan_status ?? '').toLowerCase() === 'clean',
          subject_label: safeImageSubjectLabel(result, job, candidate),
          availability_label: String(candidate.scanStatus ?? candidate.scan_status ?? '').toLowerCase() === 'clean' ? '可用' : '不可用',
        })).filter(candidate => Number.isSafeInteger(candidate.ordinal) && candidate.ordinal > 0 && candidate.visual_ref),
      },
    } : {}),
    ...((candidateLifecycle === 'failed' || candidateLifecycle === 'unknown') && selectionJobId ? {
      recovery_request: { job_id: selectionJobId, action: nextAction.type },
    } : {}),
    ...((candidateLifecycle === 'queued' || candidateLifecycle === 'processing') && selectionJobId ? {
      poll_request: { job_id: selectionJobId, max_attempts: 4, initial_delay_ms: 750, max_delay_ms: 4000 },
    } : {}),
    ...(deliverable && requestedVisualRef ? { display_request: { visual_ref: requestedVisualRef } } : deliverable && typeof args?.job_id === 'string' && args.job_id.trim() ? { display_request: { job_id: args.job_id.trim() } } : {}),
    ...(imageUrls.length ? { image_urls: imageUrls, images } : images.length ? { images } : {}),
  }
}

function merchantAssetSummary(asset) {
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return undefined
  const scanStatus = assetScanStatus(asset)
  const blocked = scanStatus === 'blocked'
  const display = asset.display && typeof asset.display === 'object' && !Array.isArray(asset.display)
    ? {
        primary_status: typeof asset.display.primaryStatus === 'string' ? asset.display.primaryStatus : 'unknown',
        label: typeof asset.display.label === 'string' ? asset.display.label : '当前暂不可用',
        source_state: typeof asset.display.sourceState === 'string' ? asset.display.sourceState : undefined,
        reasons: Array.isArray(asset.display.reasons) ? asset.display.reasons.filter(reason => typeof reason === 'string').map(sanitizeMerchantAction) : [],
        next_action: asset.display.nextAction && typeof asset.display.nextAction === 'object' ? {
          method: typeof asset.display.nextAction.method === 'string' ? asset.display.nextAction.method : undefined,
          label: typeof asset.display.nextAction.label === 'string' ? sanitizeMerchantAction(asset.display.nextAction.label) : undefined,
          allowed: asset.display.nextAction.allowed === true,
        } : null,
      }
    : undefined
  return {
    asset_id: typeof asset.id === 'string' ? asset.id : typeof asset.asset_id === 'string' ? asset.asset_id : undefined,
    name: typeof asset.name === 'string' ? asset.name : typeof asset.asset_name === 'string' ? asset.asset_name : undefined,
    mime_type: typeof asset.mimeType === 'string' ? asset.mimeType : typeof asset.mime_type === 'string' ? asset.mime_type : undefined,
    size_bytes: Number.isSafeInteger(asset.sizeBytes) ? asset.sizeBytes : Number.isSafeInteger(asset.size_bytes) ? asset.size_bytes : undefined,
    created_at: typeof asset.createdAt === 'string' ? asset.createdAt : typeof asset.created_at === 'string' ? asset.created_at : undefined,
    source: typeof asset.source === 'string' ? asset.source : undefined,
    scan_status: scanStatus,
    rights_status: typeof asset.rightsStatus === 'string' ? asset.rightsStatus : typeof asset.rights_status === 'string' ? asset.rights_status : undefined,
    readiness_status: typeof asset.readiness?.status === 'string' ? asset.readiness.status : typeof asset.status === 'string' ? asset.status : undefined,
    ...(display ? { display } : {}),
    next_step: blocked ? '重新提交这张图片即可触发平台自动复检，无需人工处理' : typeof asset.next_step === 'string' ? sanitizeMerchantAction(asset.next_step) : undefined,
  }
}

function merchantAssetStructuredContent(method, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  if (method === 'asset.list') {
    const assets = Array.isArray(result.assets) ? result.assets.map(merchantAssetSummary).filter(Boolean) : []
    const assetActions = Array.isArray(result.asset_actions) ? result.asset_actions.map(action => {
      const summary = merchantAssetSummary(action) ?? {}
      const blocked = summary.scan_status === 'blocked' || summary.readiness_status === 'blocked'
      return {
        ...summary,
        next_step: blocked ? '重新提交这张图片即可触发平台自动复检，无需人工处理' : typeof action?.next_step === 'string' ? sanitizeMerchantAction(action.next_step) : undefined,
        user_action_required: blocked,
      }
    }) : []
    return {
      assets,
      readiness: result.readiness && typeof result.readiness === 'object' && !Array.isArray(result.readiness)
        ? { draft: Number(result.readiness.draft ?? 0), ready: Number(result.readiness.ready ?? 0), blocked: Number(result.readiness.blocked ?? 0), total: Number(result.readiness.total ?? assets.length) }
        : { total: assets.length },
      ...(result.storage_quota && typeof result.storage_quota === 'object' && !Array.isArray(result.storage_quota)
        ? { storage_quota: {
            used_bytes: Number(result.storage_quota.usedBytes ?? 0),
            reserved_bytes: Number(result.storage_quota.reservedBytes ?? 0),
            limit_bytes: Number(result.storage_quota.limitBytes ?? 0),
            available_bytes: Number(result.storage_quota.availableBytes ?? 0),
            status: ['available', 'near_limit', 'over_limit'].includes(String(result.storage_quota.status)) ? result.storage_quota.status : 'unknown',
          } }
        : {}),
      asset_actions: assetActions,
      empty_state: assets.length ? null : { title: '还没有素材', message: '请先上传商品图片或品牌资料。' },
    }
  }
  if (method !== 'asset.upload') return result
  const summary = merchantAssetSummary(result) ?? {}
  const scanStatus = summary.scan_status ?? assetScanStatus(result)
  const blocked = scanStatus === 'blocked'
  const continuationState = result?.generationContinuation && typeof result.generationContinuation === 'object' ? result.generationContinuation.state : undefined
  const awaitingConfirmation = continuationState === 'awaiting_confirmation'
  return {
    ...summary,
    scanStatus,
    scan_status: scanStatus,
    scanAutomation: {
      state: blocked ? 'blocked' : awaitingConfirmation ? 'awaiting_confirmation' : scanStatus === 'clean' ? 'completed' : 'pending',
      userActionRequired: blocked || awaitingConfirmation,
      message: blocked ? '这张图片暂时不能继续使用；重新提交后由平台自动复检，无需人工处理。' : awaitingConfirmation ? '图片已通过自动安全检查。请确认图片商用权与 AI 编辑授权后再开始生成。' : scanStatus === 'clean' ? '图片检查已通过。' : '图片已收到，正在自动检查。',
    },
    scan_wait: {
      state: blocked ? 'blocked' : awaitingConfirmation ? 'awaiting_confirmation' : scanStatus === 'clean' ? 'completed' : 'processing',
      user_action_required: blocked || awaitingConfirmation,
      timed_out: result.scan_wait?.timed_out === true,
      next_step: blocked ? '重新提交这张图片即可触发平台自动复检，无需人工处理' : awaitingConfirmation ? '确认图片商用权、AI 编辑授权和开始生成' : sanitizeMerchantAction(String(result.scan_wait?.next_step ?? result.next_step ?? (scanStatus === 'clean' ? '继续当前任务' : '平台会继续自动检查，你无需操作'))),
    },
    next_step: blocked ? '重新提交这张图片即可触发平台自动复检，无需人工处理' : awaitingConfirmation ? '确认图片商用权、AI 编辑授权和开始生成' : sanitizeMerchantAction(String(result.next_step ?? (scanStatus === 'clean' ? '继续当前任务' : '平台会继续自动检查，你无需操作'))),
    ...(result.generationContinuation && typeof result.generationContinuation === 'object' && typeof result.generationContinuation.state === 'string'
      ? { generation_continuation: { state: result.generationContinuation.state } }
      : {}),
  }
}

function merchantWorkflowStructuredContent(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const workflow = result.workflow && typeof result.workflow === 'object' && !Array.isArray(result.workflow)
    ? result.workflow
    : Array.isArray(result.workflows) && result.workflows[0] && typeof result.workflows[0] === 'object'
      ? result.workflows[0]
      : undefined
  if (!workflow || !workflow.status || !workflow.next_action || !workflow.recovery) return result
  const status = workflow.status
  const progress = workflow.progress && typeof workflow.progress === 'object' ? workflow.progress : {}
  const next = workflow.next_action
  return {
    ...result,
    merchant_status: {
      state: typeof status.internal_state === 'string' ? status.internal_state : 'unknown',
      label: typeof status.user_state === 'string' ? status.user_state : '需要查看状态',
      terminal: status.terminal === true,
      ...(typeof status.updated_at === 'string' ? { updated_at: status.updated_at } : {}),
      progress: {
        known: progress.known === true,
        ...(Number.isSafeInteger(progress.completed) ? { completed: progress.completed } : {}),
        ...(Number.isSafeInteger(progress.total) ? { total: progress.total } : {}),
        label: typeof progress.label === 'string' ? progress.label : progress.known === true ? '进度已知' : '总量未知',
      },
      next_action: {
        label: typeof next.label === 'string' ? sanitizeMerchantAction(next.label) : '查看状态',
        allowed: next.allowed !== false,
      },
      recovery: {
        retryable: workflow.recovery.retryable === true,
        ...(typeof workflow.recovery.retry_scope === 'string' ? { retry_scope: sanitizeMerchantAction(workflow.recovery.retry_scope) } : {}),
        reconciliation_required: workflow.recovery.reconciliation_required === true,
      },
      ...(workflow.evidence && typeof workflow.evidence === 'object' ? { evidence: { source: workflow.evidence.source, simulated: workflow.evidence.simulated === true } } : {}),
    },
  }
}

function assetScanResult(uploadResult, asset, assetAction, timedOut = false) {
  const scanStatus = assetScanStatus(asset ?? uploadResult)
  const nextStep = scanStatus === 'clean'
    ? (typeof assetAction?.next_step === 'string' ? assetAction.next_step : '继续当前任务')
    : scanStatus === 'blocked'
      ? '重新提交这张图片即可触发平台自动复检，无需人工处理'
      : '平台会继续自动检查，你无需操作'
  const scanAutomation = {
    state: scanStatus === 'clean' ? 'completed' : scanStatus === 'blocked' ? 'blocked' : 'pending',
    mode: uploadResult?.scanAutomation?.mode ?? 'platform_worker',
    userActionRequired: scanStatus === 'blocked',
    message: scanStatus === 'clean'
      ? '图片检查已通过，可以继续当前任务。'
      : scanStatus === 'blocked'
        ? '这张图片暂时不能继续使用，未用于生成或发布。重新提交后平台会自动复检，无需人工处理。'
        : '图片已收到，正在自动进行安全检查。通过后会等待你的确认再继续生成。',
  }
  // The upload response can contain a pre-scan continuation snapshot. Once a
  // later asset.list poll proves the scan reached a terminal state, keeping
  // that old `waiting_scan` value would send the model back to an already
  // completed step. Only retain it while the scan is genuinely still pending.
  const { generationContinuation: initialGenerationContinuation, ...stableUploadResult } = uploadResult && typeof uploadResult === 'object' ? uploadResult : {}
  const generationContinuation = scanStatus === 'quarantined' && initialGenerationContinuation && typeof initialGenerationContinuation === 'object'
    ? { generationContinuation: initialGenerationContinuation }
    : {}
  return {
    ...stableUploadResult,
    ...generationContinuation,
    ...(asset && typeof asset === 'object' ? { asset } : {}),
    scanStatus,
    scan_status: scanStatus,
    scanAutomation,
    scan_wait: {
      state: scanStatus === 'clean' ? 'completed' : scanStatus === 'blocked' ? 'blocked' : 'processing',
      user_action_required: scanStatus === 'blocked',
      timed_out: timedOut,
      next_step: nextStep,
    },
    next_step: nextStep,
  }
}

async function waitForAssetScan(uploadResult) {
  const assetId = typeof uploadResult?.id === 'string'
    ? uploadResult.id
    : typeof uploadResult?.asset_id === 'string' ? uploadResult.asset_id : ''
  const initialStatus = assetScanStatus(uploadResult)
  if (!assetId || initialStatus === 'clean' || initialStatus === 'blocked') return assetScanResult(uploadResult, undefined, undefined)

  const deadline = Date.now() + ASSET_SCAN_POLL_TIMEOUT_MS
  let latestAsset
  let latestAction
  do {
    await wait(Math.min(ASSET_SCAN_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())))
    if (Date.now() > deadline) break
    let listing
    try {
      listing = await callRemote('asset.list', {})
    } catch {
      return assetScanResult(uploadResult, latestAsset, latestAction, true)
    }
    latestAsset = Array.isArray(listing?.assets) ? listing.assets.find(asset => asset?.id === assetId) : undefined
    latestAction = Array.isArray(listing?.asset_actions) ? listing.asset_actions.find(action => action?.asset_id === assetId) : undefined
    const status = assetScanStatus(latestAsset)
    if (status === 'clean' || status === 'blocked') return assetScanResult(uploadResult, latestAsset, latestAction)
  } while (Date.now() < deadline)

  return assetScanResult(uploadResult, latestAsset, latestAction, true)
}

async function handle(request) {
  const id = request.id ?? null
  if (request.jsonrpc !== '2.0') return jsonRpcError(id, -32600, 'Invalid JSON-RPC request')
  if (request.method === 'notifications/initialized') return null
  if (request.method === 'ping') return jsonRpc(id, {})
  if (request.method === 'initialize') {
    const requestedProtocol = request.params?.protocolVersion
    if (requestedProtocol && requestedProtocol !== PROTOCOL_VERSION) return jsonRpcError(id, -32602, `Unsupported MCP protocol version: ${String(requestedProtocol)}`, { supportedProtocolVersion: PROTOCOL_VERSION })
    return jsonRpc(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: 'merchant-marketing', version: PLUGIN_VERSION || 'unversioned' },
      instructions: '先调用 merchant.start；需要诊断时再调用 workspace.health。发布前必须人工确认并调用 publish.prepare。',
    })
  }
  if (request.method === 'resources/list') {
    return jsonRpc(id, { resources: [
      { uri: RECHARGE_UI_URI, name: '大麦充值', title: '大麦钱包充值', description: '显示钱包余额、额度不足提醒、充值渠道和订单状态。', mimeType: 'text/html;profile=mcp-app' },
      { uri: CREATIVE_CHOICE_UI_URI, name: '创意方向选择', title: '选择创意方向', description: '比较三个创意方向并明确确认其中一个；初始不默认选择。', mimeType: 'text/html;profile=mcp-app' },
      { uri: CONTENT_DIFF_UI_URI, name: '内容版本差异', title: '比较内容版本', description: '逐字段比较两个内容版本并明确保留其中一个。', mimeType: 'text/html;profile=mcp-app' },
      { uri: PUBLISH_CONFIRM_UI_URI, name: '最终发布确认', title: '确认发布内容', description: '核对单项或批量发布对象、变化、费用和影响后最终确认。', mimeType: 'text/html;profile=mcp-app' },
      { uri: IMAGE_EDIT_UI_URI, name: '大麦图片局部编辑', title: '图片局部编辑区域标注', description: '在图片预览上拖拽或用键盘标注归一化编辑区域，并避开不可修改区域。', mimeType: 'text/html;profile=mcp-app' },
      { uri: IMAGE_CANDIDATE_CHOICE_UI_URI, name: '主图候选选择', title: '选择主图候选', description: '展示已归档且通过自动检查的主图候选；单张可直接确认，多张可选择一张。', mimeType: 'text/html;profile=mcp-app' },
    ] })
  }
  if (request.method === 'resources/read') {
    if (request.params?.uri === CREATIVE_CHOICE_UI_URI) return jsonRpc(id, { contents: [{ uri: CREATIVE_CHOICE_UI_URI, mimeType: 'text/html;profile=mcp-app', text: creativeChoiceUiHtml(), _meta: { ui: { prefersBorder: true } } }] })
    if (request.params?.uri === CONTENT_DIFF_UI_URI) return jsonRpc(id, { contents: [{ uri: CONTENT_DIFF_UI_URI, mimeType: 'text/html;profile=mcp-app', text: contentDiffUiHtml(), _meta: { ui: { prefersBorder: true } } }] })
    if (request.params?.uri === PUBLISH_CONFIRM_UI_URI) return jsonRpc(id, { contents: [{ uri: PUBLISH_CONFIRM_UI_URI, mimeType: 'text/html;profile=mcp-app', text: publishConfirmUiHtml(), _meta: { ui: { prefersBorder: true } } }] })
    if (request.params?.uri === IMAGE_EDIT_UI_URI) return jsonRpc(id, { contents: [{ uri: IMAGE_EDIT_UI_URI, mimeType: 'text/html;profile=mcp-app', text: imageEditUiHtml(), _meta: { ui: { prefersBorder: true } } }] })
    if (request.params?.uri === IMAGE_CANDIDATE_CHOICE_UI_URI) return jsonRpc(id, { contents: [{ uri: IMAGE_CANDIDATE_CHOICE_UI_URI, mimeType: 'text/html;profile=mcp-app', text: imageCandidateChoiceUiHtml(), _meta: { ui: { prefersBorder: true, csp: { resourceDomains: imageResourceDomains() } } } }] })
    if (request.params?.uri !== RECHARGE_UI_URI) return jsonRpcError(id, -32602, `Unknown resource: ${String(request.params?.uri)}`)
    return jsonRpc(id, { contents: [{ uri: RECHARGE_UI_URI, mimeType: 'text/html;profile=mcp-app', text: rechargeUiHtml(), _meta: { ui: { prefersBorder: true } } }] })
  }
  if (request.method === 'tools/list') {
    return jsonRpc(id, { tools: Object.entries(METHODS).filter(([name]) => isMerchantTool(name)).map(([name, value]) => ({
      name,
      ...value,
      ...(RECHARGE_UI_METHODS.has(name) || MERCHANT_CONTEXT_COMPONENT_METHODS.has(name) || IMAGE_EDIT_UI_METHODS.has(name) ? { _meta: { ...(RECHARGE_UI_METHODS.has(name) ? { ui: { resourceUri: RECHARGE_UI_URI }, 'openai/outputTemplate': RECHARGE_UI_URI, 'openai/toolInvocation/invoking': name.startsWith('billing.') ? '正在读取钱包…' : '正在检查余额与额度…', 'openai/toolInvocation/invoked': name.startsWith('billing.') ? '钱包已更新' : '余额检查完成' } : {}), ...(toolUiMetadata(name) ?? {}) } } : {}),
      annotations: toolAnnotations(name),
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
    if (name === 'catalog.image.select') {
      const ticketHash = /^[a-f0-9]{64}$/u
      if (!ticketHash.test(String(args.confirmation_ticket_nonce_hash ?? '')) || !ticketHash.test(String(args.confirmation_ticket_intent_hash ?? ''))) {
        return jsonRpcError(id, -32602, 'catalog.image.select requires candidate-bound confirmation ticket SHA-256 hashes')
      }
    }
    if (name === 'workspace.interactive.confirm') {
      try {
        const result = await confirmInteractiveWrites(args)
        return jsonRpc(id, { content: toolContent(name, result), structuredContent: result, isError: false })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'interactive confirmation failed'
        const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'INTERACTIVE_CONFIRMATION_REQUIRED'
        return jsonRpc(id, { content: [{ type: 'text', text: userFacingErrorText(code) }], structuredContent: { code, message }, isError: true })
      }
    }
    if ((!SAFE_WITHOUT_INTERACTIVE_WRITE.has(name) && !allowsWriteTools()) || (ALWAYS_INTERACTIVE_WRITE_METHODS.has(name) && interactiveWriteUntil <= Date.now())) {
      const structuredContent = {
        code: 'INTERACTIVE_WRITE_DISABLED',
        message: '当前操作需要商家明确确认。请先确认后继续；如果套餐额度或钱包余额不足，我会提示充值。',
        technical_hint: 'interactive_write_session_required',
      }
      return jsonRpc(id, { content: [{ type: 'text', text: userFacingErrorText(structuredContent.code) }], structuredContent, ...(toolResultUiMetadata(name) ? { _meta: toolResultUiMetadata(name) } : {}), isError: true })
    }
    try {
      const remoteResult = await callRemote(name, prepareToolArguments(name, args))
      const rawResult = name === 'asset.upload' ? await waitForAssetScan(remoteResult) : remoteResult
      const assetResult = merchantAssetStructuredContent(name, rawResult)
      const workflowResult = merchantWorkflowStructuredContent(assetResult)
      const result = merchantImageCandidateStructuredContent(name, workflowResult, args)
      if (name === 'content.export') {
        const artifact = exportArtifactResult(result)
        return jsonRpc(id, { ...artifact, isError: false })
      }
      const normalizedResult = merchantUiMetadata(name, actionCards(name, result), args)
      const nativeImages = name === 'catalog.image.get' && normalizedResult?.candidate_state?.presentation === 'native_image' && Array.isArray(normalizedResult.images) ? normalizedResult.images : []
      const structuredContent = name === 'catalog.image.get'
        ? Object.fromEntries(Object.entries(normalizedResult).filter(([key]) => key !== 'images' && key !== 'image_urls'))
        : normalizedResult
      const selectionTickets = name === 'catalog.image.get' ? privateCandidateSelectionTickets(rawResult, normalizedResult) : []
      const resultUi = toolResultUiMetadata(name, normalizedResult, selectionTickets)
      return jsonRpc(id, { content: toolContent(name, normalizedResult), structuredContent, ...(resultUi ? { _meta: resultUi } : {}), isError: false })
    } catch (error) {
      const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'MCP_GATEWAY_ERROR'
      const details = safeErrorDetails(error && typeof error === 'object' ? error.details : undefined)
      const presentation = toolErrorPresentation(name, args, code, details)
      const rechargeRequired = code === 'RECHARGE_REQUIRED' || code === 'BILLING_INSUFFICIENT_BALANCE'
      const parseRecovery = name === 'asset.parse'
        && ['ASSET_PARSE_TIMEOUT', 'ASSET_PARSE_FAILED', 'ASSET_PARSE_EMPTY', 'ASSET_PARSE_ATTEMPTS_EXHAUSTED'].includes(code)
        && typeof args.asset_id === 'string'
        && details?.asset_persisted === true
        && details?.asset_id === args.asset_id
        ? {
            asset_id: args.asset_id,
            asset_persisted: true,
            conversation_state: {
              stage: 'confirm_asset_facts',
              current_asset_id: args.asset_id,
              workspace_binding_valid: true,
              rediscovery_required: false,
            },
            next_action: {
              method: 'asset.facts.confirm',
              arguments: { asset_id: args.asset_id },
              required_inputs: ['facts_json', 'reason'],
              instruction: '沿用当前素材继续对话；用户确认描述后直接保存人工事实。不要调用 workspace.health 重新发现素材，不要要求重新连接或重复上传。',
            },
          }
        : {}
      const structuredContent = { code, message: presentation.recovery ? presentation.text : safeStructuredErrorMessage(error, code, details), ...(details ? { details } : {}), ...(presentation.recovery ? { recovery: presentation.recovery } : {}), ...parseRecovery, ...(rechargeRequired ? { show_recharge: true, recharge_reason: '余额或套餐额度不足', recommended_amounts_cny: ['50.00', '100.00', '300.00'], recharge_channels: ['alipay', 'wechat'] } : {}) }
      return jsonRpc(id, { content: [{ type: 'text', text: presentation.text }], structuredContent, ...(toolResultUiMetadata(name) ? { _meta: toolResultUiMetadata(name) } : {}), isError: true })
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
