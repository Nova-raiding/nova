import type { Platform } from './domain.js'

export const MCP_METHODS = [
  'merchant.start',
  'merchant.first_value',
  'brand-unit.list',
  'brand-unit.create',
  'brand-unit.bind-store',
  'brand-unit.product.create',
  'brand-unit.listing.create',
  'brand-unit.listing.list',
  'brand-unit.access.grant',
  'campaign.batch.create',
  'campaign.batch.get',
  'campaign.batch.generate',
  'workspace.health',
  'workspace.bootstrap',
  'workspace.interactive.confirm',
  'workspace.metrics',
  'workspace.commercial.get',
  'workspace.commercial.update',
  'workspace.usage.get',
  'ops.audit.list',
  'ops.audit.export',
  'ops.data.delete.list',
  'ops.data.delete.cancel',
  'ops.data.delete.approve',
  'ops.members.list',
  'ops.session',
  'ops.workspaces.list',
  'ops.users.list',
  'ops.users.export',
  'ops.user.detail',
  'ops.user.suspend',
  'ops.user.activate',
  'ops.user.risk.transition',
  'ops.user.session.revoke',
  'ops.commercial.offers.list',
  'ops.commercial.offer.upsert',
  'ops.commercial.addons.list',
  'ops.commercial.addon.upsert',
  'ops.commercial.coupons.list',
  'ops.commercial.export',
  'ops.commercial.coupon.upsert',
  'ops.commercial.rollouts.list',
  'ops.commercial.rollout.upsert',
  'ops.commercial.model-markup.get',
  'ops.commercial.model-markup.update',
  'ops.growth.funnel',
  'ops.alerts.list',
  'ops.alert.ack',
  'ops.marketing.queue',
  'ops.marketing.queue.assign',
  'ops.marketing.visual.review',
  'ops.marketing.generation.retry',
  'ops.marketing.publish.acknowledge',
  'ops.marketing.revision.create',
  'ops.member.upsert',
  'ops.member.suspend',
  'subscription.get',
  'subscription.orders.list',
  'subscription.order.create',
  'subscription.change',
  'billing.usage.consume',
  'billing.usage.refund',
  'billing.refund',
  'billing.reconciliation',
  'billing.reconciliation.run',
  'billing.model-usage.reconciliation.run',
  'billing.model-usage.resolve',
  'billing.export',
  'platform.settings.get',
  'platform.settings.update',
  'platform.model.status',
  'billing.status',
  'billing.recharge.create',
  'billing.recharge.get',
  'billing.recharge.list',
  'billing.transactions',
  'workspace.deactivate',
  'workspace.activate',
  'workspace.data.delete.request',
  'platform.connect',
  'platform.store.alias.set',
  'catalog.search',
  'catalog.categories',
  'catalog.title.optimize',
  'catalog.title.accept',
  'catalog.import',
  'catalog.import.batch',
  'catalog.sku.update',
  'catalog.product.update',
  'catalog.facts.confirm',
  'catalog.product.disable',
  'catalog.product.enable',
  'catalog.image.generate',
  'catalog.image.get',
  'catalog.image.review',
  'sync.retry_failed',
  'rule.list',
  'rule.sync.status',
  'rule.history',
  'rule.audit',
  'rule.publish',
  'rule.status',
  'asset.list',
  'asset.parse',
  'asset.facts.confirm',
  'asset.preference.update',
  'brand.get',
  'brand.extract',
  'brand.upsert',
  'brand.tone.preview',
  'asset.upload',
  'asset.upload.batch',
  'asset.scan',
  'asset.rights.update',
  'catalog.sync',
  'catalog.sync.start',
  'catalog.sync.get',
  'deliverable.list',
  'task.history',
  'task.resume',
  'task.clone',
  'task.timeline',
  'feedback.list',
  'feedback.submit',
  'platform.revoke',
  'task.create',
  'task.answer',
  'task.understand',
  'task.request.create',
  'task.sku.split',
  'task.group.create',
  'creative.directions',
  'creative.brief',
  'creative.preview',
  'creative.directions.update',
  'task.select_direction',
  'task.plan.confirm',
  'content.generate',
  'content.codex.prepare',
  'content.codex.commit',
  'generation.get',
  'content.review',
  'content.review.decide',
  'content.visual.select',
  'content.versions',
  'content.diff',
  'content.export',
  'content.approve',
  'content.modify',
  'content.restore',
  'publish.prepare',
  'publish.batch.prepare',
  'publish.batch.confirm',
  'publish.batch.get',
  'publish.batch.pause',
  'publish.batch.resume',
  'publish.batch.retry_failed',
  'automation.policy.get',
  'automation.policy.list',
  'automation.policy.update',
  'automation.scan',
  'automation.tick',
  'automation.pause',
  'publish.confirm',
  'publish.get',
  'knowledge.rule.create',
  'knowledge.rule.list',
  'knowledge.asset.create',
  'knowledge.asset.update',
  'knowledge.asset.list',
  'knowledge.feedback.record',
  'knowledge.learning.list',
  'knowledge.learning.confirm',
  'knowledge.learning.dismiss',
  'knowledge.competitor.create',
  'knowledge.competitor.list',
  'knowledge.competitor.reference',
  'multimodal.image.edit',
  'multimodal.generate',
  'multimodal.video.request',
  'multimodal.video.get',
] as const

export type McpMethod = (typeof MCP_METHODS)[number]

export interface McpFieldSchema {
  readonly type: 'string'
  readonly description?: string
  readonly enum?: readonly string[]
}

export interface McpParamsSchema {
  readonly type: 'object'
  readonly properties: Readonly<Record<string, McpFieldSchema>>
  readonly required?: readonly string[]
  readonly additionalProperties: false
}

export interface McpMethodContract {
  readonly method: McpMethod
  readonly description: string
  readonly params: McpParamsSchema
}

const workspaceProperty: McpFieldSchema = { type: 'string' }
const platformProperty: McpFieldSchema = {
  type: 'string',
  enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'],
}

const params = (
  properties: Readonly<Record<string, McpFieldSchema>>,
  required: readonly string[] = [],
): McpParamsSchema => ({
  type: 'object',
  properties: { workspace_id: workspaceProperty, ...properties },
  ...(required.length ? { required } : {}),
  additionalProperties: false,
})

/** Canonical wire-level parameter schemas shared by the plugin, API and tests. */
export const MCP_METHOD_CONTRACTS: readonly McpMethodContract[] = [
  {
    method: 'merchant.start',
    description: 'Return the merchant-friendly first-use entry point, current onboarding step, store/product summary, and the next natural-language action.',
    params: params({}),
  },
  {
    method: 'merchant.first_value',
    description: 'Return a safe first-value preview bundle for the scoped platform, account, and product; `example=true` returns a static non-merchant example. It never publishes content and does not call a model unless the server explicitly says the preview requires one.',
    params: params({ platform: platformProperty, account_id: { type: 'string' }, product_id: { type: 'string' }, example: { type: 'string', enum: ['true'] } }),
  },
  {
    method: 'brand-unit.list',
    description: 'List in-memory brand units and their explicitly bound platform stores for the scoped workspace.',
    params: params({ brand_id: { type: 'string' }, platform: platformProperty, account_id: { type: 'string' } }),
  },
  {
    method: 'brand-unit.create',
    description: 'Create an in-memory brand unit for the current API process; it is not durable until persistence migration is available.',
    params: params({ brand_id: { type: 'string' }, name: { type: 'string' } }, ['name']),
  },
  {
    method: 'brand-unit.bind-store',
    description: 'Bind an existing authorized platform account to an in-memory brand unit.',
    params: params({ brand_id: { type: 'string' }, platform: platformProperty, account_id: { type: 'string' } }, ['brand_id', 'platform', 'account_id']),
  },
  {
    method: 'brand-unit.product.create',
    description: '在品下创建一个跨平台复用的 canonical product。',
    params: params({ brand_id: { type: 'string' }, product_id: { type: 'string' }, source_product_id: { type: 'string' }, title: { type: 'string' } }, ['brand_id', 'title']),
  },
  {
    method: 'brand-unit.listing.create',
    description: '将 canonical product 映射到一个已绑定的平台店铺。',
    params: params({ brand_id: { type: 'string' }, canonical_product_id: { type: 'string' }, listing_id: { type: 'string' }, platform: platformProperty, account_id: { type: 'string' }, remote_product_id: { type: 'string' } }, ['brand_id', 'canonical_product_id', 'platform', 'account_id']),
  },
  {
    method: 'brand-unit.listing.list',
    description: '查看一个品在多个平台和店铺上的商品 listing 映射。只读。',
    params: params({ brand_id: { type: 'string' }, canonical_product_id: { type: 'string' }, platform: platformProperty, account_id: { type: 'string' } }),
  },
  {
    method: 'brand-unit.access.grant',
    description: 'Grant an active workspace member viewer, editor, publisher, or admin access to one brand unit.',
    params: params({ brand_id: { type: 'string' }, external_subject: { type: 'string' }, role: { type: 'string', enum: ['viewer', 'editor', 'publisher', 'admin'] }, reason: { type: 'string' } }, ['brand_id', 'external_subject', 'role']),
  },
  {
    method: 'campaign.batch.create',
    description: '为一个品创建最多 50 个商品、平台和店铺目标的持久化批量运营计划；创建本身不会生成或发布。',
    params: params({ brand_id: { type: 'string' }, platform: platformProperty, account_id: { type: 'string' }, product_ids_json: { type: 'string' }, targets_json: { type: 'string', description: '多个商品/平台/店铺目标的 JSON 数组；每项含 product_id 或 canonical_product_id、platform、account_id，可选 listing_id' }, idempotency_key: { type: 'string', description: '重试同一批量计划时保持不变' } }, ['brand_id']),
  },
  {
    method: 'campaign.batch.get',
    description: '查看批量运营计划及逐商品工作流状态、阻断原因和下一步操作。只读状态会按任务和发布结果刷新。',
    params: params({ campaign_id: { type: 'string' } }, ['campaign_id']),
  },
  {
    method: 'campaign.batch.generate',
    description: '激活逐商品持久化工作流并创建确定性内容任务；逐项停在事实、方向、方案、审核或发布确认节点，不会越过人工门禁。',
    params: params({ campaign_id: { type: 'string' }, request_text: { type: 'string' }, idempotency_key: { type: 'string' } }, ['campaign_id']),
  },
  {
    method: 'workspace.bootstrap',
    description: 'Create a new merchant workspace during first-run onboarding; returns the immutable workspace binding.',
    params: params({ display_name: { type: 'string' }, external_subject: { type: 'string' } }, ['display_name']),
  },
  {
    method: 'workspace.health',
    description: 'Return service and platform readiness for the scoped workspace.',
    params: params({}),
  },
  {
    method: 'workspace.interactive.confirm',
    description: 'Open a short-lived interactive write session after the merchant explicitly confirms an action; automation remains read-only.',
    params: params({ confirmation: { type: 'string', enum: ['I_CONFIRM_INTERACTIVE_WRITES'] } }, ['confirmation']),
  },
  {
    method: 'workspace.metrics',
    description: 'Return workspace-scoped operational funnel and platform metrics without credentials or business正文.',
    params: params({ platform: platformProperty, account_id: { type: 'string' }, date_from: { type: 'string' }, date_to: { type: 'string' }, risk_limit: { type: 'string' } }),
  },
  { method: 'workspace.commercial.get', description: 'Return adjustable workspace pricing, quotas, and platform settings.', params: params({}) },
  { method: 'workspace.commercial.update', description: 'Update workspace pricing in CNY and included quotas with optimistic concurrency.', params: params({ plan_code: { type: 'string' }, plan_name: { type: 'string' }, monthly_price_cny: { type: 'string' }, annual_price_cny: { type: 'string' }, included_stores: { type: 'string' }, included_tasks: { type: 'string' }, expected_revision: { type: 'string' } }, ['plan_code', 'plan_name']) },
  { method: 'workspace.usage.get', description: 'Return current monthly task quota usage for the workspace.', params: params({}) },
  { method: 'ops.audit.list', description: 'List auditable commercial and platform operations for the workspace.', params: params({ limit: { type: 'string' } }) },
  { method: 'ops.audit.export', description: 'Export workspace-scoped operation and alert audit records as CSV or JSON.', params: params({ limit: { type: 'string' }, format: { type: 'string', enum: ['csv', 'json'] } }) },
  { method: 'ops.data.delete.list', description: 'List workspace-scoped data deletion requests and lifecycle states.', params: params({ limit: { type: 'string' } }) },
  { method: 'ops.data.delete.cancel', description: 'Cancel a pending data deletion request with an auditable reason.', params: params({ request_id: { type: 'string' }, reason: { type: 'string' } }, ['request_id', 'reason']) },
  { method: 'ops.data.delete.approve', description: 'Record one of two independent approvals; after the second approval the request remains pending external deletion proof.', params: params({ request_id: { type: 'string' }, reason: { type: 'string' } }, ['request_id', 'reason']) },
  { method: 'ops.members.list', description: 'List workspace members and roles without exposing credentials.', params: params({}) },
  { method: 'ops.session', description: 'Return the authenticated operator identity, roles, and current workspace grant without credentials.', params: params({}) },
  { method: 'ops.workspaces.list', description: 'List operational summaries for workspaces granted to the operator.', params: params({}) },
  { method: 'ops.users.list', description: 'List cross-workspace user memberships for platform operations.', params: params({ query: { type: 'string' }, status: { type: 'string', enum: ['invited', 'active', 'suspended'] }, workspace_id: { type: 'string' }, offset: { type: 'string' }, limit: { type: 'string' } }) },
  { method: 'ops.users.export', description: 'Export filtered cross-workspace user memberships for platform operations as a bounded CSV or JSON artifact.', params: params({ query: { type: 'string' }, status: { type: 'string', enum: ['invited', 'active', 'suspended'] }, workspace_id: { type: 'string' }, limit: { type: 'string' }, format: { type: 'string', enum: ['csv', 'json'] } }) },
  { method: 'ops.user.detail', description: 'Return one persistent platform identity, redacted sessions, lifecycle events, workspace memberships, and membership audits.', params: params({ identity_id: { type: 'string' }, issuer: { type: 'string' }, external_subject: { type: 'string' } }) },
  { method: 'ops.user.suspend', description: 'Suspend one workspace membership or a persistent platform identity with session revocation and audit evidence.', params: params({ scope: { type: 'string', enum: ['membership', 'identity'] }, workspace_id: { type: 'string' }, external_subject: { type: 'string' }, identity_id: { type: 'string' }, expected_revision: { type: 'string' }, idempotency_key: { type: 'string' }, reason: { type: 'string' } }, ['reason']) },
  { method: 'ops.user.activate', description: 'Reactivate one workspace membership or a persistent platform identity without reviving old sessions.', params: params({ scope: { type: 'string', enum: ['membership', 'identity'] }, workspace_id: { type: 'string' }, external_subject: { type: 'string' }, identity_id: { type: 'string' }, expected_revision: { type: 'string' }, idempotency_key: { type: 'string' }, reason: { type: 'string' } }, ['reason']) },
  { method: 'ops.user.risk.transition', description: 'Apply an optimistic-concurrency platform identity risk decision; block revokes every active session.', params: params({ identity_id: { type: 'string' }, risk_level: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, risk_decision: { type: 'string', enum: ['allow', 'step_up', 'block'] }, expected_revision: { type: 'string' }, idempotency_key: { type: 'string' }, reason: { type: 'string' }, evidence_json: { type: 'string' } }, ['identity_id', 'risk_level', 'risk_decision', 'expected_revision', 'idempotency_key', 'reason']) },
  { method: 'ops.user.session.revoke', description: 'Revoke one persistent platform authentication session with optimistic concurrency and immutable audit.', params: params({ identity_id: { type: 'string' }, session_id: { type: 'string' }, expected_revision: { type: 'string' }, idempotency_key: { type: 'string' }, reason: { type: 'string' } }, ['identity_id', 'session_id', 'expected_revision', 'idempotency_key', 'reason']) },
  { method: 'ops.commercial.offers.list', description: 'List configurable commercial subscription offers.', params: params({}) },
  { method: 'ops.commercial.offer.upsert', description: 'Create or update a commercial subscription offer with CNY pricing.', params: params({ code: { type: 'string' }, name: { type: 'string' }, billing_cycle: { type: 'string', enum: ['monthly', 'annual'] }, price_cny: { type: 'string' }, included_stores: { type: 'string' }, included_tasks: { type: 'string' }, active: { type: 'string', enum: ['true', 'false'] }, valid_from: { type: 'string' }, valid_to: { type: 'string' }, expected_revision: { type: 'string' }, reason: { type: 'string' } }, ['code', 'name', 'billing_cycle', 'price_cny', 'included_stores', 'included_tasks']) },
  { method: 'ops.commercial.addons.list', description: 'List configurable platform and high-cost capability add-ons.', params: params({}) },
  { method: 'ops.commercial.addon.upsert', description: 'Create or update a commercial add-on with CNY pricing.', params: params({ code: { type: 'string' }, name: { type: 'string' }, kind: { type: 'string', enum: ['platform', 'image_generation', 'bulk_sync'] }, price_cny: { type: 'string' }, units: { type: 'string' }, active: { type: 'string', enum: ['true', 'false'] }, expected_revision: { type: 'string' }, reason: { type: 'string' } }, ['code', 'name', 'kind', 'price_cny', 'units']) },
  { method: 'ops.commercial.coupons.list', description: 'List configurable coupons without exposing customer secrets.', params: params({}) },
  { method: 'ops.commercial.export', description: 'Export the current platform-owned commercial catalog and rollout rules as a bounded CSV or JSON artifact without payment credentials.', params: params({ format: { type: 'string', enum: ['csv', 'json'] } }) },
  { method: 'ops.commercial.coupon.upsert', description: 'Create or update a commercial coupon.', params: params({ code: { type: 'string' }, discount_type: { type: 'string', enum: ['fixed_cny', 'percent'] }, discount_value: { type: 'string' }, max_redemptions: { type: 'string' }, active: { type: 'string', enum: ['true', 'false'] }, valid_from: { type: 'string' }, valid_to: { type: 'string' }, expected_revision: { type: 'string' }, reason: { type: 'string' } }, ['code', 'discount_type', 'discount_value', 'max_redemptions']) },
  { method: 'ops.commercial.rollouts.list', description: 'List percentage and workspace-targeted offer rollouts.', params: params({}) },
  { method: 'ops.commercial.rollout.upsert', description: 'Create or update a percentage rollout; target_workspace_id is distinct from the routing workspace_id and omission means global for platform operations.', params: params({ offer_code: { type: 'string' }, workspace_id: { type: 'string' }, target_workspace_id: { type: 'string' }, percentage: { type: 'string' }, enabled: { type: 'string', enum: ['true', 'false'] }, reason: { type: 'string' }, expected_revision: { type: 'string' } }, ['offer_code', 'percentage', 'reason']) },
  { method: 'ops.commercial.model-markup.get', description: 'Read the global model-cost markup policy.', params: params({}) },
  { method: 'ops.commercial.model-markup.update', description: 'Update the global model-cost markup multiplier with revision protection and audit reason.', params: params({ multiplier: { type: 'string' }, expected_revision: { type: 'string' }, reason: { type: 'string' } }, ['multiplier', 'expected_revision', 'reason']) },
  { method: 'ops.growth.funnel', description: 'Return workspace-scoped conversion events grouped by source channel.', params: params({ source_channel: { type: 'string' }, date_from: { type: 'string' }, date_to: { type: 'string' } }) },
  { method: 'ops.alerts.list', description: 'List workspace-scoped operational alerts without credentials. Supports platform, store account, alert code and entity filters.', params: params({ status: { type: 'string', enum: ['open', 'acknowledged'] }, limit: { type: 'string' }, platform: platformProperty, account_id: { type: 'string' }, code: { type: 'string' }, entity_type: { type: 'string' }, entity_id: { type: 'string' } }) },
  { method: 'ops.alert.ack', description: 'Acknowledge one operational alert and retain the reason in the audit trail.', params: params({ alert_id: { type: 'string' }, reason: { type: 'string' } }, ['alert_id', 'reason']) },
  { method: 'ops.marketing.queue', description: 'Return a workspace-scoped, redacted marketing operations queue for generation, publish exceptions, visual candidates, learning suggestions, knowledge asset risks and uploaded asset readiness risks with merchant next actions. Supports platform, store, product, task and state filters. Never returns payloads, confirmation tokens or credentials.', params: params({ limit: { type: 'string' }, platform: platformProperty, account_id: { type: 'string' }, product_id: { type: 'string' }, task_id: { type: 'string' }, state: { type: 'string' } }) },
  { method: 'ops.marketing.queue.assign', description: 'Assign one generation or publish queue item to an operations owner with workspace scope, optimistic concurrency and audit evidence.', params: params({ item_type: { type: 'string', enum: ['generation', 'publish'] }, item_id: { type: 'string' }, operator_id: { type: 'string' }, expected_revision: { type: 'string' }, reason: { type: 'string' } }, ['item_type', 'item_id', 'operator_id', 'reason']) },
  { method: 'ops.marketing.visual.review', description: 'Review archived visual candidates in the operations queue; this only marks candidate findings and never selects images or approves/publishes content.', params: params({ visual_refs_json: { type: 'string' }, status: { type: 'string', enum: ['passed', 'blocked'] }, expected_revision: { type: 'string' }, reason: { type: 'string' } }, ['visual_refs_json', 'status', 'reason']) },
  { method: 'ops.marketing.generation.retry', description: 'Safely requeue one failed generation job; never retries a successful or unknown job.', params: params({ job_id: { type: 'string' }, reason: { type: 'string' } }, ['job_id', 'reason']) },
  { method: 'ops.marketing.publish.acknowledge', description: 'Acknowledge a rejected or unknown publish job for human follow-up; never replays the external write.', params: params({ publish_job_id: { type: 'string' }, reason: { type: 'string' } }, ['publish_job_id', 'reason']) },
  { method: 'ops.marketing.revision.create', description: 'Create a review-required content revision from a rejected publish version and preserve the original receipt.', params: params({ publish_job_id: { type: 'string' }, changes_json: { type: 'string' }, locked_fields_json: { type: 'string' }, reason: { type: 'string' }, expected_revision: { type: 'string' } }, ['publish_job_id', 'changes_json', 'reason']) },
  { method: 'ops.member.upsert', description: 'Create or update a workspace member role and status.', params: params({ external_subject: { type: 'string' }, display_name: { type: 'string' }, role: { type: 'string', enum: ['workspace_owner', 'merchant_admin', 'operator', 'support', 'finance', 'platform_ops'] }, status: { type: 'string', enum: ['invited', 'active', 'suspended'] }, reason: { type: 'string' } }, ['external_subject', 'role']) },
  { method: 'ops.member.suspend', description: 'Suspend a workspace member and retain the audit trail.', params: params({ external_subject: { type: 'string' }, reason: { type: 'string' } }, ['external_subject', 'reason']) },
  { method: 'subscription.get', description: 'Return the current workspace subscription and period.', params: params({}) },
  { method: 'subscription.orders.list', description: 'List subscription order snapshots for the workspace.', params: params({ limit: { type: 'string' } }) },
  { method: 'subscription.order.create', description: 'Create a subscription payment order from the server-owned commercial offer snapshot. Price and quota fields are never accepted from the caller.', params: params({ plan_code: { type: 'string' }, billing_cycle: { type: 'string', enum: ['monthly', 'annual'] }, channel: { type: 'string', enum: ['alipay', 'wechat'] }, coupon_code: { type: 'string' }, addon_codes_json: { type: 'string' }, source_channel: { type: 'string' }, idempotency_key: { type: 'string' } }, ['plan_code', 'billing_cycle', 'channel', 'idempotency_key']) },
  { method: 'subscription.change', description: 'Schedule an upgrade immediately or a downgrade at the next billing period using the server-owned offer catalog.', params: params({ to_plan_code: { type: 'string' }, billing_cycle: { type: 'string', enum: ['monthly', 'annual'] }, channel: { type: 'string', enum: ['alipay', 'wechat'] }, effective_at: { type: 'string' }, reason: { type: 'string' }, idempotency_key: { type: 'string' } }, ['to_plan_code', 'billing_cycle', 'channel', 'reason', 'idempotency_key']) },
  { method: 'billing.usage.consume', description: 'Consume one task quota unit idempotently.', params: params({ task_id: { type: 'string' }, idempotency_key: { type: 'string' } }, ['task_id', 'idempotency_key']) },
  { method: 'billing.usage.refund', description: 'Refund one previously consumed task quota unit with an auditable reason.', params: params({ task_id: { type: 'string' }, idempotency_key: { type: 'string' }, reason: { type: 'string' } }, ['task_id', 'idempotency_key', 'reason']) },
  { method: 'billing.refund', description: 'Refund a paid wallet recharge exactly once with an auditable reason.', params: params({ order_id: { type: 'string' }, reason: { type: 'string' } }, ['order_id', 'reason']) },
  { method: 'billing.reconciliation', description: 'Return workspace wallet totals and transaction evidence for reconciliation.', params: params({ limit: { type: 'string' } }) },
  { method: 'billing.reconciliation.run', description: 'Run a role-protected provider status reconciliation for pending wallet orders; paid orders settle idempotently and ambiguous results remain visible.', params: params({ limit: { type: 'string' } }) },
  { method: 'billing.model-usage.reconciliation.run', description: 'Claim and retry a bounded batch of pending model usage settlements; unresolved or ambiguous records remain visible for later operations handling.', params: params({ limit: { type: 'string' } }) },
  { method: 'billing.model-usage.resolve', description: 'Apply an optimistic-concurrency operations decision to one model usage settlement with an authenticated actor, audit reason, and evidence reference.', params: params({ usage_id: { type: 'string' }, revision: { type: 'string' }, decision: { type: 'string', enum: ['retry', 'waive', 'manual_attention'] }, reason: { type: 'string' }, evidence_ref: { type: 'string' } }, ['usage_id', 'revision', 'decision', 'reason', 'evidence_ref']) },
  { method: 'billing.export', description: 'Export workspace billing transactions as a CNY CSV or JSON artifact.', params: params({ limit: { type: 'string' }, format: { type: 'string', enum: ['csv', 'json'] } }) },
  { method: 'platform.settings.get', description: 'Return enabled state and merchant-facing names for supported platforms.', params: params({}) },
  { method: 'platform.settings.update', description: 'Update platform availability and store display settings with an auditable reason.', params: params({ platform: platformProperty, enabled: { type: 'string', enum: ['true', 'false'] }, display_name: { type: 'string' }, store_alias: { type: 'string' }, expected_revision: { type: 'string' }, reason: { type: 'string' } }, ['platform', 'reason']) },
  { method: 'platform.model.status', description: 'Return redacted platform-owned model provider readiness, quota, and cost-control metadata. Never returns credentials.', params: params({}) },
  {
    method: 'billing.status',
    description: 'Return the merchant wallet balance, supported recharge channels, and current billing mode.',
    params: params({}),
  },
  {
    method: 'billing.recharge.create',
    description: 'Create a recharge order. Production payment confirmation must come from a verified provider callback.',
    params: params({ channel: { type: 'string', enum: ['alipay', 'wechat'] }, amount_cny: { type: 'string' }, idempotency_key: { type: 'string' } }, ['channel', 'amount_cny']),
  },
  {
    method: 'billing.recharge.get',
    description: 'Read a recharge order status without exposing payment credentials.',
    params: params({ order_id: { type: 'string' }, confirm_test_payment: { type: 'string', enum: ['true'] } }, ['order_id']),
  },
  {
    method: 'billing.recharge.list',
    description: 'List recharge orders for the current workspace with optional state filtering.',
    params: params({ states: { type: 'string' }, limit: { type: 'string' } }),
  },
  {
    method: 'billing.transactions',
    description: 'List wallet transactions for the current workspace.',
    params: params({ limit: { type: 'string' } }),
  },
  {
    method: 'workspace.deactivate',
    description: 'Disable merchant workspace operations without deleting its data; health and reactivation remain available.',
    params: params({ reason: { type: 'string' } }, ['reason']),
  },
  {
    method: 'workspace.activate',
    description: 'Re-enable a disabled merchant workspace without changing retained data.',
    params: params({}),
  },
  {
    method: 'workspace.data.delete.request',
    description: 'Request deletion of workspace data after the configured grace period; this does not immediately delete data.',
    params: params({ scope: { type: 'string', enum: ['workspace', 'assets', 'business'] }, reason: { type: 'string' }, idempotency_key: { type: 'string' } }, ['scope', 'reason', 'idempotency_key']),
  },
  {
    method: 'platform.connect',
    description: 'Start official OAuth authorization for one platform account.',
    params: params({ platform: platformProperty, redirect_uri: { type: 'string' }, actor_id: { type: 'string' }, store_key: { type: 'string', description: 'Fixture-only stable store selector; real OAuth uses the provider account returned by callback.' } }, ['platform']),
  },
  {
    method: 'platform.store.alias.set',
    description: 'Set a merchant-facing alias for one explicitly selected platform account.',
    params: params({ platform: platformProperty, account_id: { type: 'string' }, alias: { type: 'string' }, expected_revision: { type: 'string' } }, ['platform', 'account_id', 'alias', 'expected_revision']),
  },
  {
    method: 'catalog.search',
    description: 'Search catalog products. Store scope requires platform + account_id; workspace aggregation must be explicit with scope=workspace. The result also includes per-product next actions for store binding or fact confirmation.',
    params: params({ scope: { type: 'string', enum: ['store', 'workspace'], description: '默认必须明确店铺；只有明确 scope=workspace 才允许全部店铺只读聚合。' }, query: { type: 'string' }, platform: platformProperty, account_id: { type: 'string' }, store_name: { type: 'string' }, brand_name: { type: 'string' }, sku_id: { type: 'string' }, remote_product_id: { type: 'string' }, listing_status: { type: 'string', enum: ['on_sale', 'off_sale', 'draft', 'unknown'] }, product_state: { type: 'string', enum: ['active', 'disabled'] }, sync_status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'partial', 'failed'] }, date_from: { type: 'string' }, date_to: { type: 'string' } }),
  },
  {
    method: 'catalog.categories',
    description: 'List workspace-visible category templates with platform mappings and required attributes.',
    params: params({ query: { type: 'string' } }),
  },
  {
    method: 'catalog.import',
    description: 'Import a confirmed local product or bind an existing platform product for a later create/update publish.',
    params: params({ platform: platformProperty, account_id: { type: 'string', description: '已授权的平台店铺账号；提供后商品会绑定该店铺。' }, remote_id: { type: 'string' }, local_product_key: { type: 'string' }, title: { type: 'string' }, category: { type: 'string' }, price: { type: 'string' }, stock: { type: 'string' }, sku_count: { type: 'string' }, skus_json: { type: 'string' }, images: { type: 'string' }, asset_ids_json: { type: 'string', description: '已上传商品素材 ID 字符串数组 JSON；绑定后图片优化默认使用这些素材。' }, attributes_json: { type: 'string' }, selling_points_json: { type: 'string', description: '最多 3 条；每条包含 id、text、proof_status、source_ids' }, store_name: { type: 'string' }, store_differentiation: { type: 'string', description: '商家确认的该店铺相对品牌的定位、客群或经营差异。' } }, ['platform', 'title']),
  },
  {
    method: 'catalog.import.batch',
    description: '批量导入最多 50 个商品；每项必须明确平台和已授权店铺，全部预校验通过后才写入商品档案。',
    params: params({ products_json: { type: 'string', description: '商品对象数组 JSON；每项包含 platform、account_id、title 及可选 SKU/价格/库存/素材/属性；asset_ids 可绑定已上传素材。' } }, ['products_json']),
  },
  { method: 'catalog.sku.update', description: '独立修改商品 SKU 的名称、价格、库存、图片和规格；修改后必须重新确认商品事实。', params: params({ product_id: { type: 'string' }, sku_id: { type: 'string' }, name: { type: 'string' }, price: { type: 'string' }, stock: { type: 'string' }, images_json: { type: 'string' }, attributes_json: { type: 'string' }, expected_version: { type: 'string' } }, ['product_id', 'sku_id']) },
  { method: 'catalog.product.update', description: '修改商品级标题、类目、主副图、属性、卖点和店铺差异化；修改后必须重新确认商品事实。', params: params({ product_id: { type: 'string' }, title: { type: 'string' }, category: { type: 'string' }, images_json: { type: 'string' }, attributes_json: { type: 'string' }, selling_points_json: { type: 'string' }, store_differentiation: { type: 'string' }, price: { type: 'string' }, expected_version: { type: 'string' } }, ['product_id']) },
  {
    method: 'catalog.facts.confirm',
    description: 'Confirm the imported or synchronized product facts before content generation or publishing.',
    params: params({ product_id: { type: 'string' } }, ['product_id']),
  },
  {
    method: 'catalog.product.disable',
    description: 'Disable a product without deleting its snapshots or historical tasks; disabled products cannot create new tasks.',
    params: params({ product_id: { type: 'string' }, reason: { type: 'string' } }, ['product_id', 'reason']),
  },
  {
    method: 'catalog.product.enable',
    description: 'Re-enable a previously disabled product while preserving its historical snapshots and tasks.',
    params: params({ product_id: { type: 'string' } }, ['product_id']),
  },
  {
    method: 'catalog.image.generate',
    description: 'Generate product main/secondary image candidates from confirmed product facts and a selected visual direction; candidates remain unapproved until reviewed.',
    params: params({ product_id: { type: 'string' }, platform: platformProperty, account_id: { type: 'string', description: '可选店铺上下文；必须与商品绑定的平台和店铺一致。' }, task_id: { type: 'string' }, content_version_id: { type: 'string' }, mode: { type: 'string', enum: ['create', 'optimize'], description: 'create 从零设计；optimize 必须基于已授权上传素材。' }, sku_ids_json: { type: 'string', description: '要生成图片的 SKU ID 字符串数组 JSON；默认使用任务冻结 SKU 范围。' }, asset_ids_json: { type: 'string', description: '已上传且通过扫描/权益/AI 修改检查的商品图片素材 ID 数组 JSON；优化模式必填。' }, direction: { type: 'string' }, count: { type: 'string' }, idempotency_key: { type: 'string' } }, ['product_id']),
  },
  {
    method: 'catalog.image.get',
    description: 'Read a product main-image generation job and its generated image variants.',
    params: params({ job_id: { type: 'string' }, visual_ref: { type: 'string' } }),
  },
  {
    method: 'catalog.image.review',
    description: 'Run deterministic checks against generated or supplied product main images.',
    params: params({ product_id: { type: 'string' }, images: { type: 'string' }, visual_refs_json: { type: 'string' } }, ['product_id']),
  },
  {
    method: 'sync.retry_failed',
    description: 'Retry retryable failures from a catalog synchronization job.',
    params: params({ job_id: { type: 'string' }, failure_ids_json: { type: 'string' } }, ['job_id']),
  },
  {
    method: 'rule.list',
    description: 'List active rule packs for the scoped workspace; optional context filters return global rules and matching scoped rules.',
    params: params({ platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, category: { type: 'string' }, brand: { type: 'string' }, store: { type: 'string' }, campaign: { type: 'string' }}),
  },
  {
    method: 'rule.sync.status',
    description: 'Show per-platform rule freshness and whether a trusted signed manifest source is configured.',
    params: params({ interval_hours: { type: 'string' } }),
  },
  {
    method: 'rule.history',
    description: 'List immutable versions for one rule pack, including inactive versions.',
    params: params({ pack_id: { type: 'string' } }, ['pack_id']),
  },
  {
    method: 'rule.audit',
    description: 'Read auditable rule publication and status-change events.',
    params: params({ pack_id: { type: 'string' } }),
  },
  {
    method: 'rule.publish',
    description: 'Create an immutable rule version; activating it requires rules-admin identity and approval_json with approval_ref, approved_by, and approved_at.',
    params: params({ pack_id: { type: 'string' }, name: { type: 'string' }, version: { type: 'string' }, scope: { type: 'string', enum: ['global', 'platform', 'category', 'brand', 'store', 'campaign'] }, source_kind: { type: 'string', enum: ['official', 'internal', 'legal_review'] }, source_reference: { type: 'string' }, source_checked_at: { type: 'string' }, effective_from: { type: 'string' }, effective_to: { type: 'string' }, severity: { type: 'string', enum: ['error', 'warning'] }, action: { type: 'string', enum: ['block', 'warn', 'review', 'allow'] }, target_id: { type: 'string' }, scope_value: { type: 'string' }, checks_json: { type: 'string' }, reason: { type: 'string' }, status: { type: 'string', enum: ['draft', 'active'] }, approval_json: { type: 'string' } }, ['pack_id', 'name', 'version', 'scope', 'source_kind', 'source_reference', 'source_checked_at', 'checks_json', 'reason']),
  },
  {
    method: 'rule.status',
    description: 'Change a rule version to active, inactive or expired with an audit reason; activation requires approval_json with approval_ref, approved_by, and approved_at.',
    params: params({ pack_id: { type: 'string' }, version: { type: 'string' }, status: { type: 'string', enum: ['active', 'inactive', 'expired'] }, reason: { type: 'string' }, approval_json: { type: 'string' } }, ['pack_id', 'version', 'status', 'reason']),
  },
  {
    method: 'asset.list',
    description: 'List workspace-scoped brand and product assets with scan, rights, explicit draft/ready/blocked readiness state, per-asset next actions, and aggregate readiness.',
    params: params({}),
  },
  {
    method: 'asset.parse',
    description: 'Parse a clean text or JSON asset into structured facts.',
    params: params({ asset_id: { type: 'string' } }, ['asset_id']),
  },
  {
    method: 'asset.facts.confirm',
    description: 'Manually confirm structured facts for a clean asset when automatic parsing or OCR is unavailable; preserves manual provenance.',
    params: params({ asset_id: { type: 'string' }, facts_json: { type: 'string' }, reason: { type: 'string' } }, ['asset_id', 'facts_json', 'reason']),
  },
  {
    method: 'asset.preference.update',
    description: 'Record or clear a merchant-authored excellent/disliked historical-asset preference with explicit reasons.',
    params: params({ asset_id: { type: 'string' }, verdict: { type: 'string', enum: ['excellent', 'disliked', 'unrated'] }, reasons_json: { type: 'string' }, note: { type: 'string' }, expected_revision: { type: 'string' } }, ['asset_id', 'verdict']),
  },
  {
    method: 'brand.get',
    description: 'Read the workspace brand profile used by content generation.',
    params: params({}),
  },
  {
    method: 'brand.extract',
    description: 'Extract review-only brand field candidates, provenance, and confidence from parsed workspace assets.',
    params: params({ asset_ids_json: { type: 'string' } }),
  },
  {
    method: 'brand.upsert',
    description: 'Create a new version of the workspace brand profile, including confirmed visual constraints.',
    params: params({ name: { type: 'string' }, positioning: { type: 'string' }, audience: { type: 'string' }, tone_json: { type: 'string' }, forbidden_terms_json: { type: 'string' }, details_json: { type: 'string' }, visual_rules_json: { type: 'string' }, source: { type: 'string' }, conflict_resolutions_json: { type: 'string' } }, ['name']),
  },
  {
    method: 'brand.tone.preview',
    description: 'Generate three short brand-tone trial passages for confirmation before formal content generation.',
    params: params({ topic: { type: 'string' }, product_id: { type: 'string' } }),
  },
  {
    method: 'asset.upload',
    description: 'Upload a small text or image asset into quarantine for scanning.',
    params: params({ name: { type: 'string' }, mime_type: { type: 'string' }, content_base64: { type: 'string' }, sha256: { type: 'string' }, rights_scope: { type: 'string', enum: ['owned', 'commercial_authorized', 'limited_use', 'internal_only', 'unknown', 'unusable'] }, applicable_platforms_json: { type: 'string' }, applicable_regions_json: { type: 'string' }, usage_scopes_json: { type: 'string' }, valid_from: { type: 'string' }, valid_to: { type: 'string' }, ai_modification_allowed: { type: 'string', enum: ['true', 'false'] } }, ['name', 'mime_type', 'content_base64']),
  },
  {
    method: 'asset.upload.batch',
    description: 'Upload up to 20 quarantined assets in one Codex operation with a 250MB batch limit.',
    params: params({ assets_json: { type: 'string' } }, ['assets_json']),
  },
  {
    method: 'asset.scan',
    description: 'Promote a quarantined asset after an external scan evidence reference is supplied.',
    params: params({ asset_id: { type: 'string' }, scan_evidence_ref: { type: 'string' } }, ['asset_id', 'scan_evidence_ref']),
  },
  {
    method: 'asset.rights.update',
    description: 'Record the human rights decision for a scanned asset without changing its binary.',
    params: params({ asset_id: { type: 'string' }, rights_status: { type: 'string', enum: ['approved', 'rejected', 'pending'] }, rights_scope: { type: 'string', enum: ['owned', 'commercial_authorized', 'limited_use', 'internal_only', 'unknown', 'unusable'] }, applicable_platforms_json: { type: 'string' }, applicable_regions_json: { type: 'string' }, usage_scopes_json: { type: 'string' }, valid_from: { type: 'string' }, valid_to: { type: 'string' }, ai_modification_allowed: { type: 'string', enum: ['true', 'false'] } }, ['asset_id', 'rights_status']),
  },
  {
    method: 'catalog.sync',
    description: 'Synchronize catalog products from an authorized platform account.',
    params: params({ platform: platformProperty, account_id: { type: 'string' }, cursor: { type: 'string' } }, ['platform']),
  },
  {
    method: 'catalog.sync.start',
    description: 'Queue a durable catalog synchronization job and return its progress handle.',
    params: params({ platform: platformProperty, account_id: { type: 'string' }, mode: { type: 'string', enum: ['full', 'incremental'] }, cursor: { type: 'string' } }, ['platform']),
  },
  {
    method: 'catalog.sync.get',
    description: 'Read a durable catalog synchronization job and its resumable cursor.',
    params: params({ job_id: { type: 'string' } }, ['job_id']),
  },
  {
    method: 'deliverable.list',
    description: 'List a paginated, metadata-only virtual index of generated content versions. It does not return bodies, images, source assets, or pre-generated files.',
    params: params({ query: { type: 'string' }, platform: platformProperty, account_id: { type: 'string' }, product_id: { type: 'string' }, task_id: { type: 'string' }, state: { type: 'string', enum: ['draft', 'review_required', 'approved', 'delivered'] }, date_from: { type: 'string' }, date_to: { type: 'string' }, limit: { type: 'string' }, cursor: { type: 'string' } }),
  },
  {
    method: 'task.history',
    description: 'Search historical marketing tasks visible to the scoped workspace.',
    params: params({ query: { type: 'string' }, platform: platformProperty, state: { type: 'string' }, product_id: { type: 'string' }, account_id: { type: 'string' }, brand_name: { type: 'string' }, store_name: { type: 'string' }, remote_product_id: { type: 'string' }, publish_status: { type: 'string', enum: ['prepared', 'confirmed', 'queued', 'submitting', 'submitted', 'reviewing', 'published', 'rejected', 'unknown', 'reconciling', 'manual_attention'] }, date_from: { type: 'string' }, date_to: { type: 'string' } }),
  },
  {
    method: 'task.resume',
    description: '恢复一个营销任务并返回持久化的待回答/暂缓问题卡；只读，不会自动回答或生成。',
    params: params({ task_id: { type: 'string' } }, ['task_id']),
  },
  {
    method: 'task.clone',
    description: 'Create a new task draft from a historical task without copying stale content or campaign prices.',
    params: params({ task_id: { type: 'string' }, request_text: { type: 'string' }, target_product_id: { type: 'string' }, target_platform: platformProperty, target_account_id: { type: 'string' }, region: { type: 'string' } }, ['task_id']),
  },
  {
    method: 'task.timeline',
    description: 'Return the durable task timeline including versions, confirmations, failures and delivery events.',
    params: params({ task_id: { type: 'string' }, limit: { type: 'string' } }, ['task_id']),
  },
  {
    method: 'feedback.list',
    description: 'List post-delivery feedback for one task without changing global rules.',
    params: params({ task_id: { type: 'string' } }, ['task_id']),
  },
  {
    method: 'feedback.submit',
    description: 'Record a task-scoped content feedback rating and optional reason.',
    params: params({ task_id: { type: 'string' }, content_version_id: { type: 'string' }, rating: { type: 'string', enum: ['liked', 'neutral', 'needs_improvement'] }, reason: { type: 'string' }, comment: { type: 'string' } }, ['task_id', 'rating']),
  },
  {
    method: 'platform.revoke',
    description: 'Revoke a platform account and immediately stop future synchronization and publishing.',
    params: params({ platform: platformProperty, account_id: { type: 'string' } }, ['platform', 'account_id']),
  },
  {
    method: 'task.create',
    description: 'Create a single-platform marketing task for one product.',
    params: params(
      { product_id: { type: 'string' }, platform: platformProperty, account_id: { type: 'string' }, region: { type: 'string', description: '素材权益匹配用的明确地区/市场代码或名称。' } },
      ['product_id', 'platform'],
    ),
  },
  {
    method: 'task.answer',
    description: 'Answer task-understanding questions and advance the resumable input snapshot; answers_json may include scoped promotion_json with CNY amounts rounded to two decimals.',
    params: params({ task_id: { type: 'string' }, answers_json: { type: 'string' }, expected_version: { type: 'string' } }, ['task_id', 'answers_json']),
  },
  {
    method: 'task.understand',
    description: 'Parse a natural-language merchant request into candidates and blocking questions.',
    params: params({ request_text: { type: 'string' } }, ['request_text']),
  },
  {
    method: 'task.request.create',
    description: 'Create one task or an idempotent independent task group directly from a natural-language request when every platform has one unambiguous product binding; otherwise return a clarification error with the understanding payload.',
    params: params({ request_text: { type: 'string' }, idempotency_key: { type: 'string' } }, ['request_text']),
  },
  {
    method: 'task.sku.split',
    description: 'Atomically split an unfrozen multi-SKU task into one independent task and auditable delivery package per SKU; each child retains its own frozen price, stock, facts, visuals and publish flow.',
    params: params({ task_id: { type: 'string' }, idempotency_key: { type: 'string' } }, ['task_id']),
  },
  {
    method: 'task.group.create',
    description: 'Create up to 50 independent platform/store/SKU subtasks under one auditable task group; the same platform/store may appear more than once only with different account_id or sku_id bindings.',
    params: params({ entries_json: { type: 'string' }, request_text: { type: 'string' } }, ['entries_json']),
  },
  {
    method: 'creative.directions',
    description: 'Return exactly three distinct creative directions for a task.',
    params: params({ task_id: { type: 'string' } }, ['task_id']),
  },
  {
    method: 'creative.brief',
    description: 'Create a fact-bound Banner, advertising asset matrix, or video storyboard brief without rendering or publishing media.',
    params: params({ product_id: { type: 'string' }, asset_type: { type: 'string', enum: ['banner', 'ad', 'video_storyboard'] }, platform: platformProperty, placement: { type: 'string' }, goal: { type: 'string' }, audience: { type: 'string' }, dimensions_json: { type: 'string' }, duration_seconds: { type: 'string' }, text_density: { type: 'string', enum: ['none', 'single_selling_point', 'title_and_subtitle', 'promotion'] }, sku_ids_json: { type: 'string' }, promotion_json: { type: 'string' } }, ['product_id', 'asset_type']),
  },
  {
    method: 'creative.preview',
    description: 'Render deterministic review previews for a fact-bound Banner or ad brief; this is not a production upload or platform approval.',
    params: params({ product_id: { type: 'string' }, asset_type: { type: 'string', enum: ['banner', 'ad'] }, platform: platformProperty, text_density: { type: 'string', enum: ['none', 'single_selling_point', 'title_and_subtitle', 'promotion'] }, count: { type: 'string' } }, ['product_id', 'asset_type']),
  },
  {
    method: 'creative.directions.update',
    description: 'Regenerate, merge, or modify creative directions while preserving immutable task revisions.',
    params: params({ action: { type: 'string', enum: ['regenerate', 'merge', 'modify'] }, task_id: { type: 'string' }, direction_ids_json: { type: 'string' }, direction_id: { type: 'string' }, changes_json: { type: 'string' }, feedback: { type: 'string' }, expected_version: { type: 'string' } }, ['task_id', 'action']),
  },
  {
    method: 'task.select_direction',
    description: 'Select one marketing direction for a task.',
    params: params({ task_id: { type: 'string' }, direction_id: { type: 'string' }, expected_version: { type: 'string' } }, ['task_id', 'direction_id']),
  },
  {
    method: 'task.plan.confirm',
    description: 'Confirm the generated production plan before formal content generation.',
    params: params({ task_id: { type: 'string' }, actor_id: { type: 'string' }, expected_version: { type: 'string' }, price_impact_confirmed: { type: 'string', enum: ['true', 'false'] } }, ['task_id']),
  },
  {
    method: 'content.generate',
    description: 'Generate a content draft from the task and its confirmed product facts.',
    params: params({ task_id: { type: 'string' }, idempotency_key: { type: 'string' } }, ['task_id']),
  },
  {
    method: 'content.codex.prepare',
    description: 'Prepare confirmed product facts for local/test Codex-native generation; production must use platform-managed content.generate and never accepts a user model key.',
    params: params({ task_id: { type: 'string' } }, ['task_id']),
  },
  {
    method: 'content.codex.commit',
    description: 'Commit a local/test Codex draft; production rejects this host-model path so all model tokens remain platform-metered.',
    params: params({ task_id: { type: 'string' }, body_json: { type: 'string' }, reason: { type: 'string' } }, ['task_id', 'body_json']),
  },
  {
    method: 'generation.get',
    description: 'Read an asynchronous content generation job and its completed version reference.',
    params: params({ job_id: { type: 'string' } }, ['job_id']),
  },
  {
    method: 'content.review',
    description: 'Run deterministic pre-publication review checks for a content version.',
    params: params({ content_version_id: { type: 'string' } }, ['content_version_id']),
  },
  {
    method: 'content.review.decide',
    description: 'Acknowledge or accept a non-blocking P1/P2 review finding with an auditable reason; P0 findings cannot be bypassed.',
    params: params({ content_version_id: { type: 'string' }, code: { type: 'string' }, field: { type: 'string' }, status: { type: 'string', enum: ['acknowledged', 'waived'] }, reason: { type: 'string' }, expected_revision: { type: 'string' } }, ['content_version_id', 'code', 'field', 'status']),
  },
  {
    method: 'content.visual.select',
    description: 'Create a new review-required content version with an explicit ordered selection of reviewed visual candidates; the first selected image is role=main and the remaining images are role=secondary.',
    params: params({ content_version_id: { type: 'string' }, visual_refs_json: { type: 'string' }, expected_revision: { type: 'string' }, idempotency_key: { type: 'string' }, reason: { type: 'string' } }, ['content_version_id', 'visual_refs_json', 'expected_revision', 'reason']),
  },
  {
    method: 'content.versions',
    description: 'List immutable content versions for a task.',
    params: params({ task_id: { type: 'string' } }, ['task_id']),
  },
  {
    method: 'content.diff',
    description: 'Compare an immutable content version with another version of the same task.',
    params: params({ content_version_id: { type: 'string' }, against_version_id: { type: 'string' } }, ['content_version_id']),
  },
  {
    method: 'content.export',
    description: 'Generate an on-demand export for one explicitly selected content version or public deliverable reference without fabricating a download or platform receipt.',
    params: params({ content_version_id: { type: 'string' }, deliverable_ref: { type: 'string' }, format: { type: 'string', enum: ['manifest', 'json', 'markdown', 'bundle'] } }),
  },
  {
    method: 'content.approve',
    description: 'Approve one immutable content version for a task.',
    params: params(
      { task_id: { type: 'string' }, content_version_id: { type: 'string' }, expected_version: { type: 'string' } },
      ['task_id', 'content_version_id'],
    ),
  },
  {
    method: 'content.modify',
    description: 'Create a new content version from local changes, or regenerate exactly one detail module while preserving the other modules and locked fields.',
    params: params({ content_version_id: { type: 'string' }, changes_json: { type: 'string' }, module_key: { type: 'string' }, locked_fields_json: { type: 'string' }, reason: { type: 'string' }, expected_revision: { type: 'string' } }, ['content_version_id', 'reason']),
  },
  {
    method: 'content.restore',
    description: 'Restore an immutable historical content version by creating a new reviewable version.',
    params: params({ content_version_id: { type: 'string' }, expected_version: { type: 'string' } }, ['content_version_id']),
  },
  {
    method: 'publish.prepare',
    description: 'Create a reviewable publish preview and confirmation hashes.',
    params: params({ task_id: { type: 'string' } }, ['task_id']),
  },
  {
    method: 'catalog.title.optimize',
    description: '基于商品事实、已确认卖点和商家关键词生成 SEO/GEO 标题建议；不承诺平台排名，必须人工确认。',
    params: params({ product_id: { type: 'string' }, platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, keyword: { type: 'string' }, objective: { type: 'string' } }, ['product_id']),
  },
  {
    method: 'catalog.title.accept',
    description: '人工确认 SEO/GEO 标题建议并写回商品；写回后必须重新确认商品事实。',
    params: params({ product_id: { type: 'string' }, platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, suggestion_id: { type: 'string' }, title: { type: 'string' }, actor_id: { type: 'string' }, expected_version: { type: 'string' } }, ['product_id', 'platform', 'suggestion_id', 'title']),
  },
  {
    method: 'publish.batch.prepare',
    description: 'Prepare up to 50 approved tasks for one explicit batch publish review; each item still requires its own confirmation hash.',
    params: params({ task_ids_json: { type: 'string' } }, ['task_ids_json']),
  },
  {
    method: 'publish.batch.confirm',
    description: '逐项确认并排队最多 50 个商品发布任务；失败项保留原因，成功项不受其他商品失败影响。',
    params: params({ batch_id: { type: 'string' }, confirmations_json: { type: 'string' } }, ['batch_id', 'confirmations_json']),
  },
  { method: 'publish.batch.get', description: '读取可恢复的批量发布状态，并刷新已排队任务的投递状态。', params: params({ batch_id: { type: 'string' } }, ['batch_id']) },
  { method: 'publish.batch.pause', description: '暂停批次后续确认和重试；已进入平台队列的项目不会被伪装成已取消。', params: params({ batch_id: { type: 'string' }, reason: { type: 'string' } }, ['batch_id', 'reason']) },
  { method: 'publish.batch.resume', description: '恢复批次的人工确认和失败项重试。', params: params({ batch_id: { type: 'string' } }, ['batch_id']) },
  { method: 'publish.batch.retry_failed', description: '使用每项新的确认哈希重新校验并排队批次失败项；成功与失败逐项返回。', params: params({ batch_id: { type: 'string' }, confirmations_json: { type: 'string' } }, ['batch_id', 'confirmations_json']) },
  { method: 'automation.policy.get', description: '查看店铺自动化运营策略和当前暂停原因。', params: params({ platform: { type: 'string' }, account_id: { type: 'string' } }) },
  { method: 'automation.policy.list', description: '列出当前工作区所有已配置的店铺自动化策略及暂停状态。', params: params({}) },
  { method: 'automation.policy.update', description: '配置店铺商品同步、风险告警和人工重试策略；不启用无人值守自动重发或发布。', params: params({ platform: { type: 'string' }, account_id: { type: 'string' }, enabled: { type: 'string', enum: ['true', 'false'] }, sync_enabled: { type: 'string', enum: ['true', 'false'] }, frequency_minutes: { type: 'string' }, retry_limit: { type: 'string' }, window_start: { type: 'string' }, window_end: { type: 'string' }, clear_window: { type: 'string', enum: ['true', 'false'] }, reason: { type: 'string' } }, ['enabled', 'reason']) },
  { method: 'automation.scan', description: '执行只读店铺健康扫描，返回同步、库存、规则、驳回和未知发布风险，并生成带官方入口与交互确认边界的结构化优化建议。', params: params({ platform: { type: 'string' }, account_id: { type: 'string' } }) },
  { method: 'automation.tick', description: '执行已到期的店铺同步与风险扫描策略并写回下一次执行时间；不自动重发或发布。', params: params({}) },
  { method: 'automation.pause', description: '暂停店铺自动化运营并记录原因。', params: params({ platform: { type: 'string' }, account_id: { type: 'string' }, reason: { type: 'string' } }, ['reason']) },
  {
    method: 'publish.confirm',
    description: 'Queue a publish only after explicit confirmation and fresh hashes.',
    params: params(
      {
        task_id: { type: 'string' },
        content_version_id: { type: 'string' },
        confirmation_hash: { type: 'string' },
        remote_snapshot_hash: { type: 'string' },
        account_id: { type: 'string' },
      },
      ['task_id', 'content_version_id', 'confirmation_hash', 'remote_snapshot_hash'],
    ),
  },
  {
    method: 'publish.get',
    description: 'Read a workspace-scoped publish job and its current delivery status.',
    params: params({ publish_job_id: { type: 'string' } }, ['publish_job_id']),
  },
  {
    method: 'knowledge.rule.create',
    description: 'Create a workspace knowledge rule with source, scope, version and effective window.',
    params: params({ name: { type: 'string' }, content: { type: 'string' }, scope: { type: 'string', enum: ['global', 'platform', 'category', 'brand', 'store', 'campaign'] }, scope_value: { type: 'string' }, platform: { type: 'string' }, category: { type: 'string' }, brand: { type: 'string' }, store: { type: 'string' }, campaign: { type: 'string' }, source_kind: { type: 'string', enum: ['official', 'internal', 'merchant', 'observed', 'legal_review'] }, source_reference: { type: 'string' }, source_checked_at: { type: 'string' }, version: { type: 'string' }, severity: { type: 'string', enum: ['info', 'warning', 'error'] }, action: { type: 'string', enum: ['warn', 'block', 'require_confirmation', 'suggest'] }, owner_id: { type: 'string' }, effective_from: { type: 'string' }, effective_to: { type: 'string' }, status: { type: 'string', enum: ['draft', 'active', 'inactive', 'archived'] }, tags_json: { type: 'string' } }, ['name', 'content', 'scope', 'source_kind', 'source_reference', 'source_checked_at', 'version', 'status']),
  },
  {
    method: 'knowledge.rule.list',
    description: 'List applicable workspace knowledge rules for a platform, category, brand, store and campaign.',
    params: params({ scope: { type: 'string' }, scope_value: { type: 'string' }, status: { type: 'string' }, as_of: { type: 'string' }, platform: { type: 'string' }, category: { type: 'string' }, brand: { type: 'string' }, store: { type: 'string' }, campaign: { type: 'string' }, text: { type: 'string' } }),
  },
  {
    method: 'knowledge.asset.create',
    description: 'Store a workspace-scoped brand or customer asset in the knowledge base.',
    params: params({ kind: { type: 'string', enum: ['brand', 'customer'] }, name: { type: 'string' }, content_json: { type: 'string' }, source: { type: 'string' }, tags_json: { type: 'string' }, approval_status: { type: 'string', enum: ['pending', 'approved', 'rejected'] }, rights_status: { type: 'string', enum: ['unknown', 'cleared', 'restricted'] } }, ['kind', 'name', 'content_json']),
  },
  {
    method: 'knowledge.asset.list',
    description: 'List workspace-scoped brand and customer knowledge assets.',
    params: params({ kind: { type: 'string', enum: ['brand', 'customer'] }, text: { type: 'string' }, tags_json: { type: 'string' } }),
  },
  {
    method: 'knowledge.asset.update',
    description: 'Update approval, rights or metadata for a workspace knowledge asset with an audit trail.',
    params: params({ asset_id: { type: 'string' }, name: { type: 'string' }, content_json: { type: 'string' }, source: { type: 'string' }, tags_json: { type: 'string' }, approval_status: { type: 'string', enum: ['pending', 'approved', 'rejected'] }, rights_status: { type: 'string', enum: ['unknown', 'cleared', 'restricted'] } }, ['asset_id']),
  },
  {
    method: 'knowledge.feedback.record',
    description: 'Record feedback or a platform rejection and create a non-activating learning suggestion.',
    params: params({ kind: { type: 'string', enum: ['feedback', 'platform_rejection'] }, platform: { type: 'string' }, content_id: { type: 'string' }, reason: { type: 'string' }, details: { type: 'string' }, metadata_json: { type: 'string' } }, ['kind', 'reason']),
  },
  {
    method: 'knowledge.learning.list',
    description: 'List pending, confirmed or dismissed learning suggestions; suggestions never activate rules automatically.',
    params: params({ status: { type: 'string', enum: ['pending', 'confirmed', 'dismissed'] } }),
  },
  {
    method: 'knowledge.learning.confirm',
    description: 'Confirm a learning suggestion as reviewed evidence without automatically activating a global rule.',
    params: params({ suggestion_id: { type: 'string' }, note: { type: 'string' } }, ['suggestion_id']),
  },
  {
    method: 'knowledge.learning.dismiss',
    description: 'Dismiss a learning suggestion with a reason without activating a global rule.',
    params: params({ suggestion_id: { type: 'string' }, note: { type: 'string' } }, ['suggestion_id']),
  },
  {
    method: 'knowledge.competitor.create',
    description: 'Record legally obtained public competitor information as structured, paraphrased analysis.',
    params: params({ competitor_name: { type: 'string' }, source_json: { type: 'string' }, summary: { type: 'string' }, structure_json: { type: 'string' }, selling_points_json: { type: 'string' }, expression_json: { type: 'string' } }, ['competitor_name', 'source_json', 'summary', 'structure_json', 'selling_points_json', 'expression_json']),
  },
  {
    method: 'knowledge.competitor.list',
    description: 'List workspace competitor analyses without copying original protected text.',
    params: params({ competitor_name: { type: 'string' }, text: { type: 'string' } }),
  },
  {
    method: 'knowledge.competitor.reference',
    description: 'Build differentiation-only creative reference from a competitor analysis.',
    params: params({ competitor_id: { type: 'string' }, own_brand_name: { type: 'string' }, own_selling_points_json: { type: 'string' } }, ['competitor_id', 'own_brand_name', 'own_selling_points_json']),
  },
  {
    method: 'multimodal.image.edit',
    description: 'Create a validated image-local-edit candidate from a marked region; never overwrites the original.',
    params: params({ request_json: { type: 'string' } }, ['request_json']),
  },
  {
    method: 'multimodal.generate',
    description: '用一句话发起文案、图片或视频脚本/分镜候选请求；生成前必须提供品牌、商品和规则快照，返回值会明确标识是否已由 provider 执行。',
    params: params({ modality: { type: 'string', enum: ['text', 'image', 'video'] }, prompt: { type: 'string' }, output: { type: 'string', enum: ['script', 'storyboard', 'rendering'] }, context_json: { type: 'string' } }, ['modality', 'prompt', 'context_json']),
  },
  {
    method: 'multimodal.video.request',
    description: 'Create a one-sentence video script/storyboard request or render a video through the platform-owned relay; the response distinguishes a planned request from provider execution.',
    params: params({ prompt: { type: 'string' }, output: { type: 'string', enum: ['script', 'storyboard', 'rendering'] }, context_json: { type: 'string' } }, ['prompt', 'output', 'context_json']),
  },
  {
    method: 'multimodal.video.get',
    description: 'Query a queued video provider job and return only a completed HTTPS artifact or an explicit queued state.',
    params: params({ provider_job_id: { type: 'string' } }, ['provider_job_id']),
  },
]

export const MCP_METHOD_SCHEMAS: Readonly<Record<McpMethod, McpParamsSchema>> =
  Object.fromEntries(MCP_METHOD_CONTRACTS.map(contract => [contract.method, contract.params])) as Readonly<Record<McpMethod, McpParamsSchema>>

export interface McpRequest {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly method: string
  readonly params?: Readonly<Record<string, unknown>>
}

export interface McpTaskCreateParams {
  readonly product_id: string
  readonly platform: Platform
}

export interface McpContentApproveParams {
  readonly task_id: string
  readonly content_version_id: string
}

export interface McpPublishPrepareParams { readonly task_id: string }

export interface McpPublishConfirmParams {
  readonly task_id: string
  readonly content_version_id: string
  readonly confirmation_hash: string
  readonly remote_snapshot_hash: string
}

export interface McpValidationResult {
  readonly valid: boolean
  readonly errors: readonly string[]
}

export function isMcpMethod(value: string): value is McpMethod {
  return (MCP_METHODS as readonly string[]).includes(value)
}

export function getMcpMethodContract(method: string): McpMethodContract | undefined {
  return isMcpMethod(method)
    ? MCP_METHOD_CONTRACTS.find(contract => contract.method === method)
    : undefined
}

/** Validate the JSON shape before dispatching it to an MCP handler. */
export function validateMcpRequest(value: unknown): McpValidationResult {
  const errors: string[] = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, errors: ['request must be an object'] }
  }
  const request = value as Record<string, unknown>
  if (request.jsonrpc !== '2.0') errors.push('jsonrpc must be 2.0')
  if (!('id' in request) || (request.id !== null && typeof request.id !== 'string' && typeof request.id !== 'number')) {
    errors.push('id must be a string, number, or null')
  }
  if (typeof request.method !== 'string' || !isMcpMethod(request.method)) {
    errors.push('method is not in the MCP allowlist')
    return { valid: false, errors }
  }
  const rawParams = request.params ?? {}
  if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
    errors.push('params must be an object')
    return { valid: false, errors }
  }
  const paramsObject = rawParams as Record<string, unknown>
  const schema = MCP_METHOD_SCHEMAS[request.method]
  for (const required of schema.required ?? []) {
    if (typeof paramsObject[required] !== 'string' || !paramsObject[required].trim()) {
      errors.push(`params.${required} is required`)
    }
  }
  for (const [key, field] of Object.entries(paramsObject)) {
    const definition = schema.properties[key]
    if (!definition) {
      errors.push(`params.${key} is not accepted for ${request.method}`)
      continue
    }
    if (!fieldType(field, definition.type) || (typeof field === 'string' && !field.trim())) {
      errors.push(`params.${key} must be a non-empty string`)
    }
    if (definition.enum && typeof field === 'string' && !definition.enum.includes(field)) {
      errors.push(`params.${key} has an unsupported value`)
    }
  }
  return { valid: errors.length === 0, errors }
}

function fieldType(value: unknown, expected: McpFieldSchema['type']): boolean {
  return expected === 'string' && typeof value === 'string'
}
