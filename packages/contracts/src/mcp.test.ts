import { describe, expect, it } from 'vitest'
import {
  MCP_METHOD_CONTRACTS,
  MCP_METHOD_RESULT_SCHEMA_NAMES,
  MCP_METHODS,
  MCP_NON_PRODUCTION_METHODS,
  MCP_METHOD_SCHEMAS,
  getMcpMethodContract,
  isMcpMethod,
  validateMcpRequest,
} from './index.js'

describe('MCP method contract', () => {
  it('bounds task.timeline limits to the API range', () => {
    const method = 'task.timeline'
    expect(MCP_METHOD_SCHEMAS[method].properties.limit).toMatchObject({ type: 'string', maxLength: 3, pattern: '^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$' })
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 'timeline-max', method, params: { task_id: 'task_1', limit: '200' } })).toEqual({ valid: true, errors: [] })
    for (const limit of ['0', '201', '1.5', '9999']) {
      expect(validateMcpRequest({ jsonrpc: '2.0', id: `timeline-${limit}`, method, params: { task_id: 'task_1', limit } }).valid).toBe(false)
    }
  })

  const productionEvidenceMethods = [
    'platform.media.spec.list',
    'platform.media.spec.get',
    'platform.media.spec.create',
    'platform.media.spec.update',
    'platform.media.spec.approve',
    'platform.media.spec.expire',
    'platform.mapping.preflight',
    'delivery.bundle.verify',
  ] as const
  const campaignControlMethods = ['campaign.batch.pause', 'campaign.batch.resume', 'campaign.batch.retry_failed'] as const

  it('restricts task history state to the supported task lifecycle values', () => {
    const state = getMcpMethodContract('task.history')?.params.properties.state
    expect(state?.enum).toEqual(expect.arrayContaining(['draft', 'review_required', 'approved', 'delivered']))
    expect(state?.enum).not.toContain('not-a-task-state')
  })

  it('returns Chinese validation explanations while preserving protocol field names', () => {
    expect(validateMcpRequest(null).errors).toEqual(['请求必须是对象'])
    expect(validateMcpRequest({ jsonrpc: '1.0', id: true, method: 'missing.method' }).errors).toEqual([
      'jsonrpc 必须为 2.0', 'id 必须是字符串、数字或 null', 'method 不在允许的 MCP 方法列表中',
    ])
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 1, method: 'catalog.search', params: [] }).errors).toEqual(['params 必须是对象'])
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 1, method: 'workspace.health', params: null }).errors).toEqual(['params 必须是对象'])
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 1, method: 'delivery.bundle.verify', params: { manifest_json: '{broken' } }).errors).toContain('params.manifest_json 必须是有效的 JSON')
  })

  it('accepts the combined merchant and platform account directory filter', () => {
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 'ops-users-all', method: 'ops.users.list', params: { account_type: 'all', limit: '10', offset: '0' },
    })).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 'ops-users-invalid', method: 'ops.users.list', params: { account_type: 'other' },
    }).valid).toBe(false)
  })

  it('declares a cursor for complete recharge order history paging', () => {
    expect(MCP_METHOD_SCHEMAS['billing.recharge.list'].properties?.cursor).toMatchObject({ type: 'string' })
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 'recharge-page-2', method: 'billing.recharge.list',
      params: { states: 'paid', limit: '100', cursor: 'opaque-page-token' },
    })).toEqual({ valid: true, errors: [] })
  })

  it('declares and validates the batch rule approval stdio contract', () => {
    expect(MCP_METHODS).toContain('rule.approve.batch')
    expect(MCP_METHOD_SCHEMAS['rule.approve.batch']).toMatchObject({
      required: ['items_json'],
      properties: {
        items_json: { type: 'string' },
      },
      additionalProperties: false,
    })

    const request = { jsonrpc: '2.0' as const, id: 'rule-batch', method: 'rule.approve.batch', params: { items_json: '[]' } }
    expect(validateMcpRequest(request)).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({ ...request, params: {} }).valid).toBe(false)
    expect(validateMcpRequest({ ...request, params: { items_json: '[]', unexpected: 'x' } }).valid).toBe(false)
  })

  it('requires an explicit tenant workspace for canonical backfill control-plane operations', () => {
    const list = { jsonrpc: '2.0' as const, id: 'canonical-conflicts', method: 'ops.canonical.backfill.conflicts.list', params: { workspace_id: 'ws_target', limit: '100' } }
    expect(validateMcpRequest(list)).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({ ...list, params: { limit: '100' } }).valid).toBe(false)
    expect(MCP_METHOD_SCHEMAS['ops.canonical.backfill.create'].required).toContain('workspace_id')
    expect(MCP_METHOD_SCHEMAS['ops.canonical.backfill.conflict.resolve'].required).toContain('workspace_id')
  })

  it('keeps the legacy methods and exposes the complete merchant workflow', () => {
    expect(MCP_METHODS.filter(method => !['workspace.interactive.confirm', 'task.resume', 'catalog.title.accept', 'catalog.sku.update', 'catalog.product.update', 'ops.marketing.queue.assign', 'ops.marketing.visual.review', 'automation.tick', 'ops.session', 'brand-unit.list', 'brand-unit.create', 'brand-unit.bind-store', 'brand-unit.product.create', 'brand-unit.listing.create', 'brand-unit.listing.list', 'campaign.batch.create', 'campaign.batch.get', 'campaign.batch.generate'].includes(method)).filter(method => !method.startsWith('ops.commercial.model-markup.'))).toEqual(expect.arrayContaining([
      'merchant.start', 'merchant.first_value', 'workspace.health', 'workspace.bootstrap', 'workspace.metrics', 'workspace.commercial.get', 'workspace.commercial.update', 'workspace.usage.get', 'ops.audit.list', 'ops.audit.detail', 'ops.audit.export', 'ops.data.delete.list', 'ops.data.delete.cancel', 'ops.data.delete.approve', 'ops.members.list', 'ops.workspaces.list', 'ops.commercial.offers.list', 'ops.commercial.offer.upsert', 'ops.commercial.addons.list', 'ops.commercial.addon.upsert', 'ops.commercial.coupons.list', 'ops.commercial.coupon.upsert', 'ops.commercial.rollouts.list', 'ops.commercial.rollout.upsert', 'ops.growth.funnel', 'ops.alerts.list', 'ops.alert.ack', 'ops.marketing.queue', 'ops.marketing.generation.retry', 'ops.marketing.asset_scan.retry', 'ops.marketing.publish.acknowledge', 'ops.marketing.revision.create', 'ops.member.upsert', 'ops.member.suspend', 'subscription.get', 'subscription.orders.list', 'subscription.order.create', 'subscription.change', 'billing.usage.consume', 'billing.usage.refund', 'billing.refund', 'billing.reconciliation', 'billing.reconciliation.run', 'billing.export', 'platform.settings.get', 'platform.settings.update', 'platform.model.status', 'billing.status', 'billing.recharge.create', 'billing.recharge.get', 'billing.transactions', 'workspace.deactivate', 'workspace.activate', 'workspace.data.delete.request', 'platform.connect', 'platform.store.alias.set', 'catalog.search', 'catalog.categories', 'catalog.title.optimize', 'catalog.import', 'catalog.import.batch', 'catalog.facts.confirm', 'catalog.product.disable', 'catalog.product.enable', 'catalog.image.generate', 'catalog.image.get', 'catalog.image.review', 'sync.retry_failed', 'rule.list', 'rule.sync.status', 'rule.history', 'rule.audit', 'rule.publish', 'rule.status', 'asset.list', 'asset.parse', 'asset.facts.confirm', 'asset.preference.update', 'brand.get', 'brand.extract', 'brand.upsert', 'brand.tone.preview', 'asset.upload', 'asset.upload.batch', 'asset.scan', 'asset.rights.update', 'catalog.sync', 'catalog.sync.start', 'catalog.sync.get', 'deliverable.list', 'task.history', 'task.clone', 'task.timeline', 'feedback.list', 'feedback.submit', 'platform.revoke', 'task.create', 'task.answer', 'task.understand', 'task.request.create', 'task.sku.split', 'task.group.create',
      'creative.directions', 'creative.brief', 'creative.preview', 'creative.directions.update', 'task.select_direction', 'task.plan.confirm', 'content.generate', 'content.draft.generate', 'content.codex.prepare', 'content.codex.commit', 'generation.get', 'content.review', 'content.review.decide', 'content.visual.select',
      'content.versions', 'content.diff', 'content.export',
      'content.approve', 'content.modify', 'content.restore', 'publish.prepare', 'publish.batch.prepare', 'publish.batch.confirm', 'publish.batch.get', 'publish.batch.pause', 'publish.batch.resume', 'publish.batch.retry_failed', 'automation.policy.get', 'automation.policy.list', 'automation.policy.update', 'automation.scan', 'automation.pause', 'publish.confirm', 'publish.get', 'ops.marketing.publish.manual-evidence.record', 'publish.manual.get', 'publish.manual.list',
      'knowledge.rule.create', 'knowledge.rule.list', 'knowledge.asset.create', 'knowledge.asset.update', 'knowledge.asset.list', 'knowledge.feedback.record', 'knowledge.learning.list', 'knowledge.learning.confirm', 'knowledge.learning.dismiss', 'knowledge.competitor.create', 'knowledge.competitor.list', 'knowledge.competitor.reference', 'multimodal.image.edit', 'multimodal.generate', 'multimodal.video.request', 'multimodal.video.get',
    ]))
    expect(MCP_METHODS).toContain('catalog.sku.update')
    expect(MCP_METHODS).toContain('catalog.product.update')
    expect(MCP_METHODS).toContain('asset.metadata.update')
    expect(MCP_METHODS).toContain('ops.marketing.queue.assign')
    expect(MCP_METHODS).toContain('ops.marketing.visual.review')
    expect(MCP_METHODS).toContain('automation.tick')
    expect(MCP_METHODS).toContain('ops.session')
    expect(MCP_METHODS).toContain('merchant.first_value')
    expect(MCP_METHODS).toContain('brand-unit.list')
    expect(MCP_METHODS).toContain('campaign.batch.create')
    expect(MCP_METHODS).toContain('canonical.product.consistency')
    expect(MCP_METHODS).toContain('ops.commercial.model-markup.get')
    expect(MCP_METHODS).toContain('ops.commercial.model-markup.update')
    expect(MCP_METHODS).toContain('ops.user.detail')
    expect(MCP_METHODS).toContain('ops.user.risk.transition')
    expect(MCP_METHODS).toContain('ops.user.session.revoke')
    expect(MCP_METHODS).toContain('billing.model-usage.reconciliation.run')
    expect(MCP_METHODS).toContain('billing.model-usage.resolve')
    expect(MCP_METHODS).toContain('workspace.data.export.request')
    expect(MCP_METHODS).toContain('workspace.data.export.get')
    expect(MCP_METHOD_SCHEMAS['workspace.data.export.request']).toMatchObject({ required: ['reason', 'idempotency_key'] })
    expect(MCP_METHOD_SCHEMAS['workspace.data.export.get']).toMatchObject({ required: ['request_id'] })
    expect(MCP_METHODS).toEqual(expect.arrayContaining([
      'ops.support.ticket.create',
      'ops.incident.transition',
      'ops.feature-flag.emergency.set',
      'ops.finance.search',
    ]))
  })

  it('rejects methods outside the allowlist', () => {
    expect(isMcpMethod('admin.raw_sql')).toBe(false)
  })

  it('marks the V2 entitlement as the authoritative current subscription fact', () => {
    const subscription = MCP_METHOD_CONTRACTS.find(contract => contract.method === 'subscription.get')
    expect(subscription?.description).toContain('commercial_entitlement (V2)')
    expect(subscription?.description).toContain('compatibility-only legacy snapshots')
  })

  it('requires exactly one image-job lookup key', () => {
    const request = (params: Record<string, string>) => validateMcpRequest({ jsonrpc: '2.0', id: 'image-get', method: 'catalog.image.get', params })
    expect(MCP_METHOD_SCHEMAS['catalog.image.get'].oneOf).toEqual([{ required: ['job_id'] }, { required: ['visual_ref'] }])
    expect(request({ job_id: 'job_1' }).valid).toBe(true)
    expect(request({ visual_ref: 'visual_1' }).valid).toBe(true)
    expect(request({}).valid).toBe(false)
    expect(request({ job_id: 'job_1', visual_ref: 'visual_1' }).valid).toBe(false)
    expect(request({ job_id: ' ' }).valid).toBe(false)
  })

  it('accepts a confirmed JSON expected scope on task.request.create', () => {
    const request = (expected_scopes: string) => validateMcpRequest({ jsonrpc: '2.0', id: 'task-scope', method: 'task.request.create', params: { request_text: '请按确认范围创建任务', expected_scopes } })
    expect(MCP_METHOD_SCHEMAS['task.request.create'].properties.expected_scopes).toMatchObject({ type: 'string', contentMediaType: 'application/json', jsonShape: 'array' })
    expect(request('[{"platform":"taobao","product_id":"product-1","sku_ids":["sku-a"]}]').valid).toBe(true)
    expect(request('{"platform":"taobao"}').valid).toBe(false)
  })

  it('requires a ticket, task, or order scope for customer-visible support replies', () => {
    const request = (params: Record<string, string>) => validateMcpRequest({ jsonrpc: '2.0', id: 'support-replies', method: 'support.customer.replies.list', params })
    expect(MCP_METHOD_SCHEMAS['support.customer.replies.list'].requiredAnyOf).toEqual(['ticket_id', 'related_task_id', 'related_order_id'])
    expect(request({}).valid).toBe(false)
    expect(request({ limit: '10' })).toMatchObject({ valid: false, errors: ['以下参数至少填写一项：params.ticket_id、params.related_task_id、params.related_order_id'] })
    expect(request({ ticket_id: 'ticket_1' }).valid).toBe(true)
    expect(request({ related_task_id: 'task_1' }).valid).toBe(true)
    expect(request({ related_order_id: 'order_1' }).valid).toBe(true)
  })

  it('declares exact bounded public rule draft review inputs', () => {
    expect(getMcpMethodContract('ops.rules.public.drafts.list')?.params.required).toBeUndefined()
    expect(MCP_METHOD_SCHEMAS['ops.rules.public.drafts.list'].properties?.limit).toMatchObject({ pattern: '^(?:[1-9]|[1-9][0-9]|100)$' })
    expect(MCP_METHOD_SCHEMAS['ops.rules.public.drafts.get']).toMatchObject({ required: ['platform', 'pack_id', 'version'] })
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 1, method: 'ops.rules.public.drafts.get', params: { platform: 'pinduoduo', pack_id: 'pdd-copy', version: '3' } }).valid).toBe(true)
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 1, method: 'ops.rules.public.drafts.get', params: { pack_id: 'pdd-copy', version: '3' } }).valid).toBe(false)
  })

  it('documents workspace bootstrap as lookup of an existing administrator binding', () => {
    const contract = getMcpMethodContract('workspace.bootstrap')
    expect(contract?.description).toContain('existing administrator-assigned workspace binding')
    expect(contract?.description).toContain('never create a tenant')
  })

  it.each(['https://example.com/contract.pdf', ' https://example.com/contract.pdf ', 'http://insecure.example/contract.pdf', '//example.com/contract.pdf', 'data:application/pdf;base64,JVBERg==', 'not-a-ref', '', 'asset:', 123, false, {}, []].map(contractRef => ({ contractRef })))('rejects external URLs and malformed customer delivery contract evidence: $contractRef', ({ contractRef }) => {
    const base = { jsonrpc: '2.0' as const, id: 'contract', method: 'ops.customer-delivery.update', params: { target_workspace_id: 'ws_1', delivery_id: 'cd_1', expected_revision: '1' } }
    const validation = validateMcpRequest({ ...base, params: { ...base.params, patch_json: JSON.stringify({ contractRef }) } })
    expect(validation).toEqual({ valid: false, errors: ['params.patch_json.contractRef 必须是已上传的 asset_ref 或 null，不能使用外部网址'] })
  })

  it.each(['asset_ref_contract-1', 'asset_ref:contract-1', 'asset_contract-1', 'asset:contract-1', 'asset://contract-1', ' \tasset_ref_contract-1\u00a0', null, undefined])('preserves contract asset references and nullable draft fields: %j', contractRef => {
    const request = { jsonrpc: '2.0' as const, id: 'contract', method: 'ops.customer-delivery.update', params: { target_workspace_id: 'ws_1', delivery_id: 'cd_1', expected_revision: '1', patch_json: JSON.stringify({ contractRef }) } }
    // Format validation is not proof of upload, binding, or a clean scan. The
    // API and persistence evidence gates remain authoritative after parsing.
    expect(validateMcpRequest(request)).toEqual({ valid: true, errors: [] })
  })

  it('keeps legacy asset.scan explicitly non-production while exposing the safe retry contract', () => {
    expect(MCP_NON_PRODUCTION_METHODS).toEqual(['asset.scan'])
    expect(MCP_METHODS).toContain('asset.scan')
    expect(getMcpMethodContract('asset.scan')?.description).toMatch(/non-production fixture compatibility only/iu)
    expect(MCP_METHOD_SCHEMAS['ops.marketing.asset_scan.retry']).toMatchObject({
      required: ['asset_id', 'event_id', 'expected_asset_revision', 'idempotency_key', 'reason'],
      properties: {
        asset_id: { minLength: 1, maxLength: 200 },
        event_id: { minLength: 1, maxLength: 200 },
        expected_asset_revision: { pattern: '^[1-9][0-9]*$', maxLength: 10 },
        idempotency_key: { minLength: 8, maxLength: 200 },
        reason: { minLength: 3, maxLength: 1000 },
      },
    })
    expect(getMcpMethodContract('ops.marketing.asset_scan.retry')?.description).toMatch(/never marks an asset clean.*signed platform scanner callback/iu)
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 'scan-retry-valid', method: 'ops.marketing.asset_scan.retry',
      params: { asset_id: 'asset_1', event_id: 'event_1', expected_asset_revision: '3', idempotency_key: 'asset-scan:retry:1', reason: 'scanner timeout recovered' },
    })).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 'scan-retry-invalid', method: 'ops.marketing.asset_scan.retry',
      params: { asset_id: 'asset_1', event_id: 'event_1', expected_asset_revision: '0', idempotency_key: 'short', reason: 'no' },
    }).errors).toEqual(expect.arrayContaining([
      'params.expected_asset_revision 格式无效',
      'params.idempotency_key 至少需要 8 个字符',
      'params.reason 至少需要 3 个字符',
    ]))
  })

  it('declares every production-evidence method exactly once with fail-closed semantics', () => {
    expect(new Set(MCP_METHODS).size).toBe(MCP_METHODS.length)
    expect(new Set(MCP_METHOD_CONTRACTS.map(contract => contract.method)).size).toBe(MCP_METHOD_CONTRACTS.length)
    for (const method of productionEvidenceMethods) {
      expect(MCP_METHODS.filter(candidate => candidate === method)).toHaveLength(1)
      expect(MCP_METHOD_CONTRACTS.filter(contract => contract.method === method)).toHaveLength(1)
      expect(getMcpMethodContract(method)?.description).toMatch(/fail-closed/iu)
    }
  })

  it('declares each campaign control exactly once with optimistic write intent', () => {
    for (const method of campaignControlMethods) {
      expect(MCP_METHODS.filter(candidate => candidate === method)).toHaveLength(1)
      expect(MCP_METHOD_CONTRACTS.filter(contract => contract.method === method)).toHaveLength(1)
      expect(MCP_METHOD_SCHEMAS[method]).toMatchObject({
        required: ['campaign_id', 'expected_revision', 'idempotency_key', 'reason'],
        properties: {
          campaign_id: { type: 'string', minLength: 1, maxLength: 200 },
          expected_revision: { pattern: '^[1-9][0-9]*$' },
          idempotency_key: { minLength: 8, maxLength: 200 },
          reason: { minLength: 3, maxLength: 1000 },
        },
      })
    }
    expect(MCP_METHOD_SCHEMAS['campaign.batch.retry_failed'].properties.item_ids_json).toMatchObject({ contentMediaType: 'application/json', jsonShape: 'array' })
    expect(MCP_METHOD_SCHEMAS['campaign.batch.pause'].properties).not.toHaveProperty('item_ids_json')
    expect(MCP_METHOD_SCHEMAS['campaign.batch.resume'].properties).not.toHaveProperty('item_ids_json')
  })

  it('keeps manual publish reports distinct from platform-verified receipts', () => {
    const schema = MCP_METHOD_SCHEMAS['ops.marketing.publish.manual-evidence.record']
    expect(schema.required).toEqual([
      'target_workspace_id', 'task_id', 'content_version_id', 'platform', 'account_id', 'delivery_bundle_hash', 'status',
      'occurred_at', 'evidence_refs_json', 'expected_revision', 'idempotency_key', 'reason',
    ])
    expect(schema.properties.status?.enum).toEqual([
      'manual_publish_in_progress', 'manual_publish_reported', 'manual_review_required',
    ])
    expect(schema.properties.evidence_refs_json).toMatchObject({ contentMediaType: 'application/json', jsonShape: 'array', maxLength: 16_384 })
    expect(getMcpMethodContract('ops.marketing.publish.manual-evidence.record')?.description).toMatch(/never.*platform_verified/iu)
    expect(getMcpMethodContract('publish.manual.get')?.description).toMatch(/not platform_verified/iu)

    const validParams = {
      target_workspace_id: 'workspace_1', task_id: 'task_1', content_version_id: 'content_1', platform: 'douyin', account_id: 'store_1',
      delivery_bundle_hash: 'a'.repeat(64), status: 'manual_publish_reported', occurred_at: '2026-09-17T10:30:00Z',
      evidence_refs_json: '["asset_ref_screenshot_1"]', expected_revision: '1',
      idempotency_key: 'manual-publish:task_1:1', reason: 'Operator reported the approved bundle as submitted.',
    }
    const method = 'ops.marketing.publish.manual-evidence.record'
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 'manual-report', method, params: validParams })).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 'manual-verified', method, params: { ...validParams, status: 'platform_verified' } }).errors).toContain('params.status 的值不受支持')
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 'manual-published', method, params: { ...validParams, status: 'published' } }).errors).toContain('params.status 的值不受支持')
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 'manual-fake-receipt', method, params: { ...validParams, platform_verified: 'true' } }).errors).toContain(`${method} 不接受参数 params.platform_verified`)
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 'manual-get', method: 'publish.manual.get', params: { manual_publish_report_id: 'manual_report_1' } })).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 'manual-list', method: 'publish.manual.list', params: { task_id: 'task_1', limit: '20', offset: '0' } })).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 'manual-list-invalid', method: 'publish.manual.list', params: { limit: '0' } }).valid).toBe(false)
  })

  it('requires exactly one checklist update mode and always scopes customer delivery to a target workspace', () => {
    const customerDeliveryMethods = [
      'ops.customer-delivery.list', 'ops.customer-delivery.get', 'ops.customer-delivery.create',
      'ops.customer-delivery.update', 'ops.customer-delivery.checklist.update',
      'ops.customer-delivery.checklist-items.list', 'ops.customer-delivery.checklist-item.update',
      'ops.customer-delivery.training.complete', 'ops.customer-delivery.videos.list', 'ops.customer-delivery.videos.add',
      'ops.customer-delivery.assets.upload', 'ops.customer-delivery.assets.get',
    ] as const
    for (const method of customerDeliveryMethods) expect(MCP_METHOD_SCHEMAS[method].required).toContain('target_workspace_id')
    expect(MCP_METHOD_SCHEMAS['ops.customer-delivery.list'].properties.archived_only).toMatchObject({ type: 'string', enum: ['true', 'false'] })
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 'delivery-archive-list', method: 'ops.customer-delivery.list', params: { target_workspace_id: 'ws_delivery', archived_only: 'true' } })).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 'delivery-archive-list-invalid', method: 'ops.customer-delivery.list', params: { target_workspace_id: 'ws_delivery', archived_only: 'yes' } }).valid).toBe(false)
    const schema = MCP_METHOD_SCHEMAS['ops.customer-delivery.checklist.update']
    expect(schema.properties.items_json).toMatchObject({ contentMediaType: 'application/json', jsonShape: 'array', maxLength: 16_384 })
    expect(MCP_METHOD_SCHEMAS['ops.customer-delivery.update'].properties.patch_json).toMatchObject({ contentMediaType: 'application/json', jsonShape: 'object', maxLength: 16_384 })
    expect(MCP_METHOD_SCHEMAS['ops.customer-delivery.checklist-item.update'].properties.evidence_json).toMatchObject({ contentMediaType: 'application/json', jsonShape: 'object', maxLength: 16_384 })
    expect(MCP_METHOD_SCHEMAS['ops.customer-delivery.training.complete'].required).toContain('evidence_refs_json')
    expect(MCP_METHOD_SCHEMAS['ops.customer-delivery.assets.upload']!.properties.purpose?.enum).toEqual(['contract', 'payment', 'system_integration', 'functional_acceptance', 'training', 'video'])
    expect(schema.required).toEqual(['target_workspace_id', 'delivery_id', 'checklist_key', 'expected_revision'])
    expect(schema.requiredAnyOf).toEqual(['completed', 'items_json'])
    expect(schema.mutuallyExclusive).toEqual([['completed', 'items_json']])
    const base = { target_workspace_id: 'ws_delivery', delivery_id: 'delivery_1', checklist_key: 'system_integration', expected_revision: '1' }
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 'checklist-completed', method: 'ops.customer-delivery.checklist.update', params: { ...base, checklist_key: 'customer_profile', completed: 'false' } })).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 'checklist-items', method: 'ops.customer-delivery.checklist.update', params: { ...base, items_json: '[]' } })).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 'checklist-wrong-shape', method: 'ops.customer-delivery.checklist.update', params: { ...base, items_json: '{}' } }).errors).toContain('params.items_json 必须是 JSON 数组')
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 'patch-wrong-shape', method: 'ops.customer-delivery.update', params: { target_workspace_id: 'ws_delivery', delivery_id: 'delivery_1', expected_revision: '1', patch_json: '[]' } }).errors).toContain('params.patch_json 必须是 JSON 对象')
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 'checklist-neither', method: 'ops.customer-delivery.checklist.update', params: base }).errors).toContain('以下参数至少填写一项：params.completed、params.items_json')
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 'checklist-both', method: 'ops.customer-delivery.checklist.update', params: { ...base, completed: 'true', items_json: '[]' } }).errors).toContain('以下参数不能同时填写：params.completed、params.items_json')
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 'checklist-no-target', method: 'ops.customer-delivery.checklist.update', params: { ...base, target_workspace_id: '', completed: 'true' } }).errors).toContain('缺少必填参数 params.target_workspace_id')
  })

  it.each(['true', 'false'])('restricts scalar checklist completed=%s to customer_profile', completed => {
    const params = { target_workspace_id: 'ws_delivery', delivery_id: 'delivery_1', expected_revision: '1', completed }
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 'profile-scalar', method: 'ops.customer-delivery.checklist.update', params: { ...params, checklist_key: 'customer_profile' } })).toEqual({ valid: true, errors: [] })
    for (const checklist_key of ['system_integration', 'functional_acceptance']) {
      expect(validateMcpRequest({ jsonrpc: '2.0', id: 'derived-scalar', method: 'ops.customer-delivery.checklist.update', params: { ...params, checklist_key } }).errors).toContain('仅当 params.checklist_key 为 customer_profile 时才能提供 params.completed；其他情况请使用 items_json 或 checklist-item.update')
    }
  })

  it('accepts ordinary profile fields and payment references but rejects derived or training patch fields', () => {
    const base = { jsonrpc: '2.0', id: 'profile-patch', method: 'ops.customer-delivery.update', params: { target_workspace_id: 'ws_delivery', delivery_id: 'delivery_1', expected_revision: '1' } }
    const profile = { companyName: '客户企业', contractNumber: 'C-2026-01', paymentStatus: 'paid', contractRef: 'asset_ref_contract_1', projectOwner: '负责人', supportOwner: '支持人', paymentDate: '2026-09-14', paymentEvidenceRefs: ['asset_ref_payment_1'], plannedGoLiveAt: '2026-10-01T01:00:00.000Z', customerProfileStatus: 'incomplete' }
    expect(validateMcpRequest({ ...base, params: { ...base.params, patch_json: JSON.stringify(profile) } })).toEqual({ valid: true, errors: [] })
    for (const field of ['systemIntegrationStatus', 'functionalAcceptanceStatus', 'trainingCompleted', 'trainingEvidenceRefs', 'effectiveAt', 'unknown']) {
      expect(validateMcpRequest({ ...base, params: { ...base.params, patch_json: JSON.stringify({ ...profile, [field]: null }) } }).errors).toContain(`更新客户交付档案时不接受 params.patch_json.${field}`)
    }
  })

  it.each(['true', 'false'])('requires strict training evidence JSON even for completed=%s', completed => {
    const request = { jsonrpc: '2.0', id: 'training-evidence', method: 'ops.customer-delivery.training.complete', params: { target_workspace_id: 'ws_delivery', delivery_id: 'delivery_1', expected_revision: '1', completed } }
    expect(validateMcpRequest(request).errors).toContain('缺少必填参数 params.evidence_refs_json')
    expect(MCP_METHOD_SCHEMAS['ops.customer-delivery.training.complete'].properties.evidence_refs_json).toMatchObject({ contentMediaType: 'application/json', jsonShape: 'array', maxLength: 16_384 })
    expect(validateMcpRequest({ ...request, params: { ...request.params, evidence_refs_json: '[]' } })).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({ ...request, params: { ...request.params, evidence_refs_json: '["asset_ref_training_1"]' } })).toEqual({ valid: true, errors: [] })
    for (const evidence_refs_json of ['not-json', '["asset_ref_training_1",]']) expect(validateMcpRequest({ ...request, params: { ...request.params, evidence_refs_json } }).errors).toContain('params.evidence_refs_json 必须是有效的 JSON')
    for (const evidence_refs_json of ['{}', 'null', '"asset_ref_training_1"']) expect(validateMcpRequest({ ...request, params: { ...request.params, evidence_refs_json } }).errors).toContain('params.evidence_refs_json 必须是 JSON 数组')
  })

  it('publishes completion evidence requirements without claiming static validation proves clean scans', () => {
    expect(getMcpMethodContract('ops.customer-delivery.checklist.update')?.description).toContain('evidence.asset_refs is optional')
    expect(getMcpMethodContract('ops.customer-delivery.checklist-item.update')?.description).toContain('evidence_json.asset_refs is optional')
    expect(getMcpMethodContract('ops.customer-delivery.training.complete')?.description).toContain('proof is not required')
    for (const checklist_key of ['system_integration', 'functional_acceptance']) {
      const params = { target_workspace_id: 'ws_delivery', delivery_id: 'delivery_1', checklist_key, expected_revision: '1' }
      expect(validateMcpRequest({ jsonrpc: '2.0', id: 'item-evidence', method: 'ops.customer-delivery.checklist-item.update', params: { ...params, item_key: 'test-item', completed: 'true', evidence_json: '{"asset_refs":["asset_ref_evidence_1"]}' } })).toEqual({ valid: true, errors: [] })
      expect(validateMcpRequest({ jsonrpc: '2.0', id: 'batch-evidence', method: 'ops.customer-delivery.checklist.update', params: { ...params, items_json: '[{"itemKey":"test-item","completed":true,"evidence":{"asset_refs":["asset_ref_evidence_1"]}}]' } })).toEqual({ valid: true, errors: [] })
      expect(validateMcpRequest({ jsonrpc: '2.0', id: 'wrong-item-evidence', method: 'ops.customer-delivery.checklist-item.update', params: { ...params, item_key: 'test-item', completed: 'true', evidence_json: '[]' } }).errors).toContain('params.evidence_json 必须是 JSON 对象')
    }
  })

  it('defines an explicit parameter schema for every method', () => {
    expect(MCP_METHOD_CONTRACTS).toHaveLength(MCP_METHODS.length)
    for (const method of MCP_METHODS) {
      expect(MCP_METHOD_SCHEMAS[method]).toMatchObject({ type: 'object', additionalProperties: false })
    }
    expect(MCP_METHOD_SCHEMAS['task.create'].required).toEqual(['product_id', 'platform'])
    expect(MCP_METHOD_SCHEMAS['canonical.product.consistency']).toMatchObject({ type: 'object', properties: { workspace_id: { type: 'string' } }, additionalProperties: false })
    expect(MCP_METHOD_SCHEMAS['publish.confirm'].required).toEqual([
      'task_id', 'content_version_id', 'confirmation_hash', 'remote_snapshot_hash',
    ])
    expect(MCP_METHOD_SCHEMAS['catalog.sync'].required).toEqual(['platform'])
    expect(MCP_METHOD_SCHEMAS['catalog.import'].properties.skus_json?.type).toBe('string')
    expect(MCP_METHOD_SCHEMAS['catalog.search'].properties.date_from).toMatchObject({ type: 'string', format: 'date-time' })
    expect(MCP_METHOD_SCHEMAS['catalog.search'].properties.date_to).toMatchObject({ type: 'string', format: 'date-time' })
    expect(MCP_METHOD_SCHEMAS['task.history'].properties.date_from).toMatchObject({ type: 'string', format: 'date-time' })
    expect(MCP_METHOD_SCHEMAS['task.history'].properties.date_to).toMatchObject({ type: 'string', format: 'date-time' })
    expect(MCP_METHOD_SCHEMAS['ops.platform.product.import.batch'].properties.store_assignment_confirmed).toEqual({ type: 'string', enum: ['true'] })
    expect(MCP_METHOD_SCHEMAS['asset.facts.confirm'].required).toEqual(['asset_id', 'facts_json', 'reason'])
    expect(MCP_METHOD_SCHEMAS['asset.preference.update'].properties.verdict?.enum).toEqual(['excellent', 'disliked', 'unrated'])
    expect(MCP_METHOD_SCHEMAS['brand.extract'].required).toBeUndefined()
    expect(MCP_METHOD_SCHEMAS['content.export'].properties.format?.enum).toEqual(['manifest', 'json', 'markdown', 'bundle'])
    expect(MCP_METHOD_SCHEMAS['deliverable.list'].properties.limit).toEqual({ type: 'string' })
    expect(MCP_METHOD_SCHEMAS['workspace.metrics'].properties).toMatchObject({
      platform: { type: 'string' },
      account_id: { type: 'string' },
      date_from: { type: 'string' },
      date_to: { type: 'string' },
      risk_limit: { type: 'string' },
    })
    expect(MCP_METHOD_SCHEMAS['workspace.metrics'].properties.workspace_id).toEqual({ type: 'string' })
    expect(MCP_METHOD_SCHEMAS['merchant.start']).toEqual({
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        requested_platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] },
        requested_goal: {
          type: 'string', minLength: 1, maxLength: 2_000,
          description: 'The merchant\'s explicit natural-language goal for this task intent.',
        },
        attachment_count: {
          type: 'string', pattern: '^(?:[0-9]|1[0-9]|20)$', maxLength: 2,
          description: 'Number of ChatGPT attachments associated with this intent, encoded as a wire-level integer string from 0 through 20.',
        },
        idempotency_key: { type: 'string', minLength: 8, maxLength: 200, pattern: '^[A-Za-z0-9._:-]+$' },
      },
      additionalProperties: false,
    })
    expect(MCP_METHOD_SCHEMAS['merchant.start'].required).toBeUndefined()
    expect(MCP_METHOD_SCHEMAS['merchant.first_value']).toEqual({
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] },
        account_id: { type: 'string' },
        product_id: { type: 'string' },
        example: { type: 'string', enum: ['true'] },
        draft: { type: 'string', enum: ['true'] },
        draft_title: { type: 'string', minLength: 2, maxLength: 256 },
        draft_prompt: { type: 'string', minLength: 2, maxLength: 2_000 },
        idempotency_key: { type: 'string', minLength: 8, maxLength: 200 },
      },
      additionalProperties: false,
    })
    expect(MCP_METHOD_SCHEMAS['merchant.first_value'].required).toBeUndefined()
    expect(getMcpMethodContract('merchant.first_value')?.description).toMatch(/safe first-value preview bundle.*never publishes/iu)
    expect(MCP_METHOD_SCHEMAS['brand-unit.bind-store'].required).toEqual(['brand_id', 'platform', 'account_id'])
    expect(MCP_METHOD_SCHEMAS['brand-unit.bind-store'].properties.expected_revision).toEqual({ type: 'string', pattern: '^[1-9][0-9]*$', maxLength: 10 })
    expect(MCP_METHOD_SCHEMAS['rule.status'].properties.expected_revision).toEqual({ type: 'string', pattern: '^[1-9][0-9]*$', maxLength: 10 })
    // The Ops console always sends an auditable reason and the handler reads it
    // (server.ts brand-unit.bind-store -> recordOperationAudit). Declaring the
    // optional key is what keeps that write from being rejected as off-contract.
    expect(MCP_METHOD_SCHEMAS['brand-unit.bind-store'].properties.reason).toEqual({ type: 'string', minLength: 3, maxLength: 1_000, description: 'Auditable operator reason for this interactive write.' })
    // task.sku.split/task.request.create declare idempotency_key and the handler
    // reads params.idempotency_key, so task.group.create must not be stricter.
    expect(MCP_METHOD_SCHEMAS['task.group.create'].properties.idempotency_key).toEqual({ type: 'string' })
    // mcpPagination reads limit/offset and the handler switches to
    // listContentVersionsPage when either is supplied; the schema must allow both.
    expect(MCP_METHOD_SCHEMAS['content.versions'].properties.limit).toEqual({ type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$', maxLength: 3 })
    expect(MCP_METHOD_SCHEMAS['content.versions'].properties.offset).toEqual({ type: 'string', pattern: '^(?:0|[1-9][0-9]*)$', maxLength: 10 })
    expect(MCP_METHOD_SCHEMAS['campaign.batch.create'].required).toEqual(['brand_id'])
    expect(MCP_METHOD_SCHEMAS['campaign.batch.create'].properties.product_ids_json).toMatchObject({ type: 'string', description: expect.stringContaining('1 至 50') })
    expect(MCP_METHOD_SCHEMAS['campaign.batch.generate'].properties.request_text).toMatchObject({ type: 'string', description: expect.stringContaining('素材类型') })
    expect(MCP_METHOD_SCHEMAS['catalog.import.batch'].requiredAnyOf).toEqual(['products_json', 'source_asset_id'])
    expect(MCP_METHOD_SCHEMAS['ops.user.detail'].required).toBeUndefined()
    expect(MCP_METHOD_SCHEMAS['ops.user.risk.transition']).toMatchObject({
      required: ['identity_id', 'risk_level', 'risk_decision', 'expected_revision', 'idempotency_key', 'reason'],
      properties: {
        risk_level: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        risk_decision: { type: 'string', enum: ['allow', 'step_up', 'block'] },
        evidence_json: { type: 'string' },
      },
    })
    expect(MCP_METHOD_SCHEMAS['ops.user.session.revoke'].required).toEqual(['identity_id', 'session_id', 'expected_revision', 'idempotency_key', 'reason'])
    expect(MCP_METHOD_SCHEMAS['billing.model-usage.reconciliation.run']).toMatchObject({ properties: { limit: { type: 'string' } } })
    expect(MCP_METHOD_SCHEMAS['billing.model-usage.statement'].properties?.manual_attention_cursor).toMatchObject({ type: 'string', maxLength: 512, pattern: '^[A-Za-z0-9_-]+$' })
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 1, method: 'billing.model-usage.statement', params: { manual_attention_cursor: 'eyJ2IjoxfQ' } })).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 1, method: 'billing.model-usage.statement', params: { manual_attention_cursor: '../bad' } }).valid).toBe(false)
    expect(MCP_METHOD_SCHEMAS['billing.model-usage.resolve']).toMatchObject({
      required: ['usage_id', 'revision', 'decision', 'reason', 'evidence_ref'],
      properties: {
        decision: { type: 'string', enum: ['retry', 'waive', 'manual_attention'] },
        evidence_ref: { type: 'string' },
      },
    })
    expect(MCP_METHOD_SCHEMAS['workspace.activate'].required).toEqual(['reason'])
    expect(MCP_METHOD_SCHEMAS['ops.commercial.offer.upsert'].required).toContain('reason')
    expect(MCP_METHOD_SCHEMAS['ops.support.ticket.transition']).toMatchObject({
      required: ['ticket_id', 'status', 'reason', 'expected_revision', 'idempotency_key'],
      properties: {
        reason: { minLength: 3, maxLength: 1000 },
        expected_revision: { pattern: '^[1-9][0-9]*$' },
        idempotency_key: { minLength: 8, maxLength: 200 },
      },
    })
    expect(MCP_METHOD_SCHEMAS['ops.incident.scope.update'].required).toEqual([
      'incident_id', 'expected_revision', 'affected_components_json', 'affected_workspace_ids_json', 'note', 'idempotency_key',
    ])
    expect(MCP_METHOD_SCHEMAS['ops.feature-flag.emergency.set'].required).toEqual([
      'id', 'disabled', 'expected_revision', 'idempotency_key', 'reason',
    ])
    expect(MCP_METHOD_SCHEMAS['ops.finance.search'].properties).not.toHaveProperty('provider_transaction_id')
    expect(MCP_METHOD_SCHEMAS['ops.finance.search'].properties).not.toHaveProperty('payment_url')
    expect(MCP_METHOD_SCHEMAS['ops.audit.list'].properties.limit).toEqual({
      type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$', maxLength: 3,
    })
    expect(MCP_METHOD_SCHEMAS['ops.audit.detail']).toMatchObject({
      required: ['source', 'id'],
      properties: {
        source: { type: 'string', enum: ['operation', 'rule', 'incident', 'support'] },
        id: { type: 'string', minLength: 1, maxLength: 256 },
      },
    })
    expect(MCP_METHOD_SCHEMAS['ops.audit.export'].properties).not.toHaveProperty('cursor')
    expect(MCP_METHOD_SCHEMAS['ops.audit.export'].properties).not.toHaveProperty('format')
    expect(MCP_METHOD_SCHEMAS['ops.member.upsert']).toMatchObject({
      required: ['external_subject', 'role', 'reason'],
      properties: {
        expected_revision: { pattern: '^[1-9][0-9]*$' },
        reason: { minLength: 3, maxLength: 1000 },
      },
    })
    expect(MCP_METHOD_SCHEMAS['ops.member.suspend']).toMatchObject({
      required: ['external_subject', 'expected_revision', 'reason'],
      properties: {
        expected_revision: { pattern: '^[1-9][0-9]*$' },
        reason: { minLength: 3, maxLength: 1000 },
      },
    })
    expect(MCP_METHOD_SCHEMAS['platform.media.spec.create']).toMatchObject({
      required: expect.arrayContaining(['expected_revision', 'idempotency_key', 'reason', 'spec_json']),
      properties: {
        expected_revision: { enum: ['0'] },
        spec_json: { contentMediaType: 'application/json', jsonShape: 'object' },
      },
    })
    for (const method of ['platform.media.spec.update', 'platform.media.spec.approve', 'platform.media.spec.expire'] as const) {
      expect(MCP_METHOD_SCHEMAS[method].required).toEqual(expect.arrayContaining(['expected_revision', 'idempotency_key', 'reason']))
    }
    expect(MCP_METHOD_SCHEMAS['platform.mapping.preflight'].properties.input_json).toMatchObject({ contentMediaType: 'application/json', jsonShape: 'object' })
    expect(MCP_METHOD_SCHEMAS['delivery.bundle.verify'].properties).toMatchObject({
      manifest_json: { contentMediaType: 'application/json', jsonShape: 'object' },
      files_json: { contentMediaType: 'application/json', jsonShape: 'array' },
    })
  })

  it('registers the canonical result as a typed, versioned OpenAPI result', () => {
    expect(MCP_METHOD_RESULT_SCHEMA_NAMES['canonical.product.consistency']).toBe('McpCanonicalProductConsistencyResult')
    expect(MCP_METHOD_CONTRACTS.find(contract => contract.method === 'canonical.product.consistency')?.params.additionalProperties).toBe(false)
  })

  it('requires valid confirmation ticket hashes when selecting an image candidate', () => {
    const validParams = {
      job_id: 'image_job_1',
      visual_ref: 'visual_1',
      expected_revision: '1',
      idempotency_key: 'image:select:1',
      reason: 'merchant selected this candidate',
      confirmation_ticket_nonce_hash: 'a'.repeat(64),
      confirmation_ticket_intent_hash: 'b'.repeat(64),
    }

    expect(MCP_METHOD_SCHEMAS['catalog.image.select']).toMatchObject({
      required: expect.arrayContaining(['confirmation_ticket_nonce_hash', 'confirmation_ticket_intent_hash']),
      properties: {
        confirmation_ticket_nonce_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        confirmation_ticket_intent_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      },
    })
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 'image-select-valid', method: 'catalog.image.select', params: validParams,
    })).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 'image-select-missing', method: 'catalog.image.select',
      params: {
        job_id: validParams.job_id,
        visual_ref: validParams.visual_ref,
        expected_revision: validParams.expected_revision,
        idempotency_key: validParams.idempotency_key,
        reason: validParams.reason,
      },
    }).errors).toEqual(expect.arrayContaining([
      '缺少必填参数 params.confirmation_ticket_nonce_hash',
      '缺少必填参数 params.confirmation_ticket_intent_hash',
    ]))
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 'image-select-invalid', method: 'catalog.image.select',
      params: {
        ...validParams,
        confirmation_ticket_nonce_hash: 'a'.repeat(63),
        confirmation_ticket_intent_hash: 'g'.repeat(64),
      },
    }).errors).toEqual(expect.arrayContaining([
      'params.confirmation_ticket_nonce_hash 格式无效',
      'params.confirmation_ticket_intent_hash 格式无效',
    ]))
  })

  it('accepts valid requests and rejects malformed or over-permissive params', () => {
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 'start-1', method: 'merchant.start',
      params: {
        requested_platform: 'jd',
        requested_goal: '用附件生成京东白底主图',
        attachment_count: '1',
        idempotency_key: 'merchant:start:chat-1',
      },
    })).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 'start-empty', method: 'merchant.start', params: {},
    })).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 'start-invalid', method: 'merchant.start',
      params: {
        requested_platform: 'aliexpress',
        requested_goal: ' ',
        attachment_count: '21',
        idempotency_key: 'short',
        unexpected_context: 'must remain rejected',
      },
    }).errors).toEqual(expect.arrayContaining([
      'params.requested_platform 的值不受支持',
      'params.requested_goal 必须是非空字符串',
      'params.attachment_count 格式无效',
      'params.idempotency_key 至少需要 8 个字符',
      'merchant.start 不接受参数 params.unexpected_context',
    ]))
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 'start-number', method: 'merchant.start', params: { attachment_count: 1 },
    }).errors).toContain('params.attachment_count 必须是非空字符串')
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 'start-max', method: 'merchant.start',
      params: { requested_goal: 'x'.repeat(2_001), attachment_count: '20' },
    }).errors).toContain('params.requested_goal 最多允许 2000 个字符')
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'task.create',
      params: { product_id: 'prod_1', platform: 'taobao' },
    })).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'task.create',
      params: { product_id: 'prod_1', platform: 'aliexpress' },
    }).valid).toBe(false)
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'catalog.search', params: { raw_sql: 'select 1' },
    }).errors).toContain('catalog.search 不接受参数 params.raw_sql')
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'content.export', params: { content_version_id: 'cv_1', format: 'pdf' },
    }).valid).toBe(false)
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'workspace.metrics',
      params: { date_from: '2026-08-18T00:00:00+08:00', date_to: '2026-08-25T23:59:59+08:00', risk_limit: '25' },
    })).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'workspace.metrics', params: { platform: 'jd', account_id: 'acct_other' },
    })).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'workspace.metrics', params: { risk_limit: 25 },
    }).valid).toBe(false)
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'merchant.first_value',
      params: { platform: 'taobao', account_id: 'acct_1', product_id: 'prod_1' },
    })).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'merchant.first_value', params: { publish: true },
    }).errors).toContain('merchant.first_value 不接受参数 params.publish')
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'ops.user.risk.transition',
      params: { identity_id: 'identity_1', risk_level: 'critical', risk_decision: 'block', expected_revision: '2', idempotency_key: 'risk-1', reason: 'credential abuse', evidence_json: '{"signal":"impossible_travel"}' },
    })).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'ops.user.risk.transition',
      params: { identity_id: 'identity_1', risk_level: 'critical', risk_decision: 'delete', expected_revision: '2', idempotency_key: 'risk-1', reason: 'credential abuse' },
    }).valid).toBe(false)
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'ops.user.session.revoke',
      params: { identity_id: 'identity_1', session_id: 'session_1', expected_revision: '3', idempotency_key: 'revoke-1', reason: 'lost device' },
    })).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 1, method: 'billing.model-usage.reconciliation.run', params: { limit: '25' } })).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'billing.model-usage.resolve',
      params: { usage_id: 'usage_1', revision: '4', decision: 'waive', reason: 'approved service credit', evidence_ref: 'evidence://case/1' },
    })).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'billing.model-usage.resolve',
      params: { usage_id: 'usage_1', revision: '4', decision: 'waive', reason: 'approved service credit' },
    }).errors).toContain('缺少必填参数 params.evidence_ref')
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'billing.model-usage.resolve',
      params: { usage_id: 'usage_1', revision: '4', decision: 'settled', reason: 'unsupported decision', actor_id: 'caller-controlled' },
    }).valid).toBe(false)
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'ops.support.ticket.transition',
      params: { ticket_id: 'ticket_1', status: 'resolved', reason: 'ok', expected_revision: '0', idempotency_key: 'short' },
    }).errors).toEqual(expect.arrayContaining([
      'params.reason 至少需要 3 个字符',
      'params.expected_revision 格式无效',
      'params.idempotency_key 至少需要 8 个字符',
    ]))
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'ops.feature-flag.emergency.set',
      params: { id: 'flag_1', disabled: 'true', expected_revision: '2', idempotency_key: 'flag:disable:1', reason: 'active incident' },
    })).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 2, method: 'platform.media.spec.update',
      params: { id: 'spec_1', patch_json: '{"version":"2026-08"}', expected_revision: '2', idempotency_key: 'media:update:1', reason: 'refresh production evidence' },
    })).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 3, method: 'platform.media.spec.update',
      params: { id: 'spec_1', patch_json: '[]', expected_revision: '2', idempotency_key: 'media:update:2', reason: 'wrong structured shape' },
    }).errors).toContain('params.patch_json 必须是 JSON 对象')
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 4, method: 'delivery.bundle.verify',
      params: { manifest_json: '{}', files_json: '{"path":"manifest.json"}', expected_manifest_hash: 'a'.repeat(64) },
    }).errors).toContain('params.files_json 必须是 JSON 数组')
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 5, method: 'campaign.batch.pause',
      params: { campaign_id: 'campaign_1', expected_revision: '3', idempotency_key: 'campaign:pause:1', reason: 'operator requested pause' },
    })).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 6, method: 'campaign.batch.retry_failed',
      params: { campaign_id: 'campaign_1', expected_revision: '0', idempotency_key: 'short', reason: 'no' },
    }).errors).toEqual(expect.arrayContaining([
      'params.expected_revision 格式无效',
      'params.idempotency_key 至少需要 8 个字符',
      'params.reason 至少需要 3 个字符',
    ]))
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 7, method: 'campaign.batch.retry_failed',
      params: { campaign_id: 'campaign_1', item_ids_json: '{}', expected_revision: '3', idempotency_key: 'campaign:retry:1', reason: 'retry selected failed items' },
    }).errors).toContain('params.item_ids_json 必须是 JSON 数组')
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'ops.finance.search',
      params: { text: 'x'.repeat(201), provider_transaction_id: 'full-secret-reference' },
    }).errors).toEqual(expect.arrayContaining([
      'params.text 最多允许 200 个字符',
      'ops.finance.search 不接受参数 params.provider_transaction_id',
    ]))
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'ops.finance.search', params: { limit: '101' },
    }).errors).toContain('params.limit 格式无效')
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'ops.audit.detail', params: { source: 'incident', id: 'incident:evt_1' },
    })).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'ops.audit.detail', params: { source: 'payments', id: 'evt_1', raw_payload: '{}' },
    }).errors).toEqual(expect.arrayContaining([
      'params.source 的值不受支持',
      'ops.audit.detail 不接受参数 params.raw_payload',
    ]))
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'ops.member.upsert',
      params: { external_subject: 'member_1', role: 'support' },
    }).errors).toContain('缺少必填参数 params.reason')
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'ops.member.suspend',
      params: { external_subject: 'member_1', reason: 'security review' },
    }).errors).toContain('缺少必填参数 params.expected_revision')
  })
})

describe('candidate formalization contract', () => {
  it('requires explicit candidate/task confirmation and never implies approval or publishing', () => {
    const contract = getMcpMethodContract('content.draft.confirm')
    expect(contract?.description).toContain('review-required formal content version')
    expect(contract?.description).toContain('never approves or publishes')
    expect(MCP_METHOD_SCHEMAS['content.draft.confirm'].required).toEqual(['task_id', 'body_json'])
    const valid = validateMcpRequest({ jsonrpc: '2.0', id: 'candidate-confirm', method: 'content.draft.confirm', params: { task_id: 'task_1', body_json: '{}', reason: '商家确认候选并进入审核' } })
    expect(valid).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 1, method: 'content.draft.confirm', params: { task_id: 'task_1', reason: '不确认' } }).valid).toBe(false)
  })
})
