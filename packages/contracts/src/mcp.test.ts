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

  it('keeps the legacy methods and exposes the complete merchant workflow', () => {
    expect(MCP_METHODS.filter(method => !['workspace.interactive.confirm', 'task.resume', 'catalog.title.accept', 'catalog.sku.update', 'catalog.product.update', 'ops.marketing.queue.assign', 'ops.marketing.visual.review', 'automation.tick', 'ops.session', 'brand-unit.list', 'brand-unit.create', 'brand-unit.bind-store', 'brand-unit.product.create', 'brand-unit.listing.create', 'brand-unit.listing.list', 'campaign.batch.create', 'campaign.batch.get', 'campaign.batch.generate'].includes(method)).filter(method => !method.startsWith('ops.commercial.model-markup.'))).toEqual(expect.arrayContaining([
      'merchant.start', 'merchant.first_value', 'workspace.health', 'workspace.bootstrap', 'workspace.metrics', 'workspace.commercial.get', 'workspace.commercial.update', 'workspace.usage.get', 'ops.audit.list', 'ops.audit.detail', 'ops.audit.export', 'ops.data.delete.list', 'ops.data.delete.cancel', 'ops.data.delete.approve', 'ops.members.list', 'ops.workspaces.list', 'ops.commercial.offers.list', 'ops.commercial.offer.upsert', 'ops.commercial.addons.list', 'ops.commercial.addon.upsert', 'ops.commercial.coupons.list', 'ops.commercial.coupon.upsert', 'ops.commercial.rollouts.list', 'ops.commercial.rollout.upsert', 'ops.growth.funnel', 'ops.alerts.list', 'ops.alert.ack', 'ops.marketing.queue', 'ops.marketing.generation.retry', 'ops.marketing.asset_scan.retry', 'ops.marketing.publish.acknowledge', 'ops.marketing.revision.create', 'ops.member.upsert', 'ops.member.suspend', 'subscription.get', 'subscription.orders.list', 'subscription.order.create', 'subscription.change', 'billing.usage.consume', 'billing.usage.refund', 'billing.refund', 'billing.reconciliation', 'billing.reconciliation.run', 'billing.export', 'platform.settings.get', 'platform.settings.update', 'platform.model.status', 'billing.status', 'billing.recharge.create', 'billing.recharge.get', 'billing.transactions', 'workspace.deactivate', 'workspace.activate', 'workspace.data.delete.request', 'platform.connect', 'platform.store.alias.set', 'catalog.search', 'catalog.categories', 'catalog.title.optimize', 'catalog.import', 'catalog.import.batch', 'catalog.facts.confirm', 'catalog.product.disable', 'catalog.product.enable', 'catalog.image.generate', 'catalog.image.get', 'catalog.image.review', 'sync.retry_failed', 'rule.list', 'rule.sync.status', 'rule.history', 'rule.audit', 'rule.publish', 'rule.status', 'asset.list', 'asset.parse', 'asset.facts.confirm', 'asset.preference.update', 'brand.get', 'brand.extract', 'brand.upsert', 'brand.tone.preview', 'asset.upload', 'asset.upload.batch', 'asset.scan', 'asset.rights.update', 'catalog.sync', 'catalog.sync.start', 'catalog.sync.get', 'deliverable.list', 'task.history', 'task.clone', 'task.timeline', 'feedback.list', 'feedback.submit', 'platform.revoke', 'task.create', 'task.answer', 'task.understand', 'task.request.create', 'task.sku.split', 'task.group.create',
      'creative.directions', 'creative.brief', 'creative.preview', 'creative.directions.update', 'task.select_direction', 'task.plan.confirm', 'content.generate', 'content.draft.generate', 'content.codex.prepare', 'content.codex.commit', 'generation.get', 'content.review', 'content.review.decide', 'content.visual.select',
      'content.versions', 'content.diff', 'content.export',
      'content.approve', 'content.modify', 'content.restore', 'publish.prepare', 'publish.batch.prepare', 'publish.batch.confirm', 'publish.batch.get', 'publish.batch.pause', 'publish.batch.resume', 'publish.batch.retry_failed', 'automation.policy.get', 'automation.policy.list', 'automation.policy.update', 'automation.scan', 'automation.pause', 'publish.confirm', 'publish.get',
      'knowledge.rule.create', 'knowledge.rule.list', 'knowledge.asset.create', 'knowledge.asset.update', 'knowledge.asset.list', 'knowledge.feedback.record', 'knowledge.learning.list', 'knowledge.learning.confirm', 'knowledge.learning.dismiss', 'knowledge.competitor.create', 'knowledge.competitor.list', 'knowledge.competitor.reference', 'multimodal.image.edit', 'multimodal.generate', 'multimodal.video.request', 'multimodal.video.get',
    ]))
    expect(MCP_METHODS).toContain('catalog.sku.update')
    expect(MCP_METHODS).toContain('catalog.product.update')
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

  it.each(['https://example.com/contract.pdf', ' https://example.com/contract.pdf ', 'http://insecure.example/contract.pdf', '//example.com/contract.pdf', 'data:application/pdf;base64,JVBERg==', 'not-a-ref', '', 'asset:', 123, false, {}, []].map(contractRef => ({ contractRef })))('rejects external URLs and malformed customer delivery contract evidence: $contractRef', ({ contractRef }) => {
    const base = { jsonrpc: '2.0' as const, id: 'contract', method: 'ops.customer-delivery.update', params: { target_workspace_id: 'ws_1', delivery_id: 'cd_1', expected_revision: '1' } }
    const validation = validateMcpRequest({ ...base, params: { ...base.params, patch_json: JSON.stringify({ contractRef }) } })
    expect(validation).toEqual({ valid: false, errors: ['params.patch_json.contractRef must be an uploaded asset_ref or null; external URLs are not accepted'] })
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
      'params.expected_asset_revision has an invalid format',
      'params.idempotency_key must contain at least 8 characters',
      'params.reason must contain at least 3 characters',
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

  it('requires exactly one checklist update mode and always scopes customer delivery to a target workspace', () => {
    const customerDeliveryMethods = [
      'ops.customer-delivery.list', 'ops.customer-delivery.get', 'ops.customer-delivery.create',
      'ops.customer-delivery.update', 'ops.customer-delivery.checklist.update',
      'ops.customer-delivery.checklist-items.list', 'ops.customer-delivery.checklist-item.update',
      'ops.customer-delivery.training.complete', 'ops.customer-delivery.videos.list', 'ops.customer-delivery.videos.add',
      'ops.customer-delivery.assets.upload', 'ops.customer-delivery.assets.get',
    ] as const
    for (const method of customerDeliveryMethods) expect(MCP_METHOD_SCHEMAS[method].required).toContain('target_workspace_id')
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
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 'checklist-wrong-shape', method: 'ops.customer-delivery.checklist.update', params: { ...base, items_json: '{}' } }).errors).toContain('params.items_json must be a JSON array')
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 'patch-wrong-shape', method: 'ops.customer-delivery.update', params: { target_workspace_id: 'ws_delivery', delivery_id: 'delivery_1', expected_revision: '1', patch_json: '[]' } }).errors).toContain('params.patch_json must be a JSON object')
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 'checklist-neither', method: 'ops.customer-delivery.checklist.update', params: base }).errors).toContain('params.completed or items_json is required')
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 'checklist-both', method: 'ops.customer-delivery.checklist.update', params: { ...base, completed: 'true', items_json: '[]' } }).errors).toContain('params.completed and items_json are mutually exclusive')
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 'checklist-no-target', method: 'ops.customer-delivery.checklist.update', params: { ...base, target_workspace_id: '', completed: 'true' } }).errors).toContain('params.target_workspace_id is required')
  })

  it.each(['true', 'false'])('restricts scalar checklist completed=%s to customer_profile', completed => {
    const params = { target_workspace_id: 'ws_delivery', delivery_id: 'delivery_1', expected_revision: '1', completed }
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 'profile-scalar', method: 'ops.customer-delivery.checklist.update', params: { ...params, checklist_key: 'customer_profile' } })).toEqual({ valid: true, errors: [] })
    for (const checklist_key of ['system_integration', 'functional_acceptance']) {
      expect(validateMcpRequest({ jsonrpc: '2.0', id: 'derived-scalar', method: 'ops.customer-delivery.checklist.update', params: { ...params, checklist_key } }).errors).toContain('params.completed is only accepted for checklist_key customer_profile; use items_json or checklist-item.update')
    }
  })

  it('accepts ordinary profile fields and payment references but rejects derived or training patch fields', () => {
    const base = { jsonrpc: '2.0', id: 'profile-patch', method: 'ops.customer-delivery.update', params: { target_workspace_id: 'ws_delivery', delivery_id: 'delivery_1', expected_revision: '1' } }
    const profile = { companyName: '客户企业', contractNumber: 'C-2026-01', paymentStatus: 'paid', contractRef: 'asset_ref_contract_1', projectOwner: '负责人', supportOwner: '支持人', paymentDate: '2026-09-14', paymentEvidenceRefs: ['asset_ref_payment_1'], plannedGoLiveAt: '2026-10-01T01:00:00.000Z', customerProfileStatus: 'incomplete' }
    expect(validateMcpRequest({ ...base, params: { ...base.params, patch_json: JSON.stringify(profile) } })).toEqual({ valid: true, errors: [] })
    for (const field of ['systemIntegrationStatus', 'functionalAcceptanceStatus', 'trainingCompleted', 'trainingEvidenceRefs', 'effectiveAt', 'unknown']) {
      expect(validateMcpRequest({ ...base, params: { ...base.params, patch_json: JSON.stringify({ ...profile, [field]: null }) } }).errors).toContain(`params.patch_json.${field} is not accepted for customer delivery profile updates`)
    }
  })

  it.each(['true', 'false'])('requires strict training evidence JSON even for completed=%s', completed => {
    const request = { jsonrpc: '2.0', id: 'training-evidence', method: 'ops.customer-delivery.training.complete', params: { target_workspace_id: 'ws_delivery', delivery_id: 'delivery_1', expected_revision: '1', completed } }
    expect(validateMcpRequest(request).errors).toContain('params.evidence_refs_json is required')
    expect(MCP_METHOD_SCHEMAS['ops.customer-delivery.training.complete'].properties.evidence_refs_json).toMatchObject({ contentMediaType: 'application/json', jsonShape: 'array', maxLength: 16_384 })
    expect(validateMcpRequest({ ...request, params: { ...request.params, evidence_refs_json: '["asset_ref_training_1"]' } })).toEqual({ valid: true, errors: [] })
    for (const evidence_refs_json of ['not-json', '["asset_ref_training_1",]']) expect(validateMcpRequest({ ...request, params: { ...request.params, evidence_refs_json } }).errors).toContain('params.evidence_refs_json must be valid JSON')
    for (const evidence_refs_json of ['{}', 'null', '"asset_ref_training_1"']) expect(validateMcpRequest({ ...request, params: { ...request.params, evidence_refs_json } }).errors).toContain('params.evidence_refs_json must be a JSON array')
  })

  it('publishes completion evidence requirements without claiming static validation proves clean scans', () => {
    expect(getMcpMethodContract('ops.customer-delivery.checklist.update')?.description).toContain('evidence.asset_refs')
    expect(getMcpMethodContract('ops.customer-delivery.checklist-item.update')?.description).toContain('evidence_json.asset_refs')
    expect(getMcpMethodContract('ops.customer-delivery.training.complete')?.description).toContain('Functional acceptance never completes training automatically')
    for (const checklist_key of ['system_integration', 'functional_acceptance']) {
      const params = { target_workspace_id: 'ws_delivery', delivery_id: 'delivery_1', checklist_key, expected_revision: '1' }
      expect(validateMcpRequest({ jsonrpc: '2.0', id: 'item-evidence', method: 'ops.customer-delivery.checklist-item.update', params: { ...params, item_key: 'test-item', completed: 'true', evidence_json: '{"asset_refs":["asset_ref_evidence_1"]}' } })).toEqual({ valid: true, errors: [] })
      expect(validateMcpRequest({ jsonrpc: '2.0', id: 'batch-evidence', method: 'ops.customer-delivery.checklist.update', params: { ...params, items_json: '[{"itemKey":"test-item","completed":true,"evidence":{"asset_refs":["asset_ref_evidence_1"]}}]' } })).toEqual({ valid: true, errors: [] })
      expect(validateMcpRequest({ jsonrpc: '2.0', id: 'wrong-item-evidence', method: 'ops.customer-delivery.checklist-item.update', params: { ...params, item_key: 'test-item', completed: 'true', evidence_json: '[]' } }).errors).toContain('params.evidence_json must be a JSON object')
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
      'params.confirmation_ticket_nonce_hash is required',
      'params.confirmation_ticket_intent_hash is required',
    ]))
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 'image-select-invalid', method: 'catalog.image.select',
      params: {
        ...validParams,
        confirmation_ticket_nonce_hash: 'a'.repeat(63),
        confirmation_ticket_intent_hash: 'g'.repeat(64),
      },
    }).errors).toEqual(expect.arrayContaining([
      'params.confirmation_ticket_nonce_hash has an invalid format',
      'params.confirmation_ticket_intent_hash has an invalid format',
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
      'params.requested_platform has an unsupported value',
      'params.requested_goal must be a non-empty string',
      'params.attachment_count has an invalid format',
      'params.idempotency_key must contain at least 8 characters',
      'params.unexpected_context is not accepted for merchant.start',
    ]))
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 'start-number', method: 'merchant.start', params: { attachment_count: 1 },
    }).errors).toContain('params.attachment_count must be a non-empty string')
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 'start-max', method: 'merchant.start',
      params: { requested_goal: 'x'.repeat(2_001), attachment_count: '20' },
    }).errors).toContain('params.requested_goal must contain at most 2000 characters')
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
    }).errors).toContain('params.raw_sql is not accepted for catalog.search')
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
    }).errors).toContain('params.publish is not accepted for merchant.first_value')
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
    }).errors).toContain('params.evidence_ref is required')
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'billing.model-usage.resolve',
      params: { usage_id: 'usage_1', revision: '4', decision: 'settled', reason: 'unsupported decision', actor_id: 'caller-controlled' },
    }).valid).toBe(false)
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'ops.support.ticket.transition',
      params: { ticket_id: 'ticket_1', status: 'resolved', reason: 'ok', expected_revision: '0', idempotency_key: 'short' },
    }).errors).toEqual(expect.arrayContaining([
      'params.reason must contain at least 3 characters',
      'params.expected_revision has an invalid format',
      'params.idempotency_key must contain at least 8 characters',
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
    }).errors).toContain('params.patch_json must be a JSON object')
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 4, method: 'delivery.bundle.verify',
      params: { manifest_json: '{}', files_json: '{"path":"manifest.json"}', expected_manifest_hash: 'a'.repeat(64) },
    }).errors).toContain('params.files_json must be a JSON array')
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 5, method: 'campaign.batch.pause',
      params: { campaign_id: 'campaign_1', expected_revision: '3', idempotency_key: 'campaign:pause:1', reason: 'operator requested pause' },
    })).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 6, method: 'campaign.batch.retry_failed',
      params: { campaign_id: 'campaign_1', expected_revision: '0', idempotency_key: 'short', reason: 'no' },
    }).errors).toEqual(expect.arrayContaining([
      'params.expected_revision has an invalid format',
      'params.idempotency_key must contain at least 8 characters',
      'params.reason must contain at least 3 characters',
    ]))
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 7, method: 'campaign.batch.retry_failed',
      params: { campaign_id: 'campaign_1', item_ids_json: '{}', expected_revision: '3', idempotency_key: 'campaign:retry:1', reason: 'retry selected failed items' },
    }).errors).toContain('params.item_ids_json must be a JSON array')
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'ops.finance.search',
      params: { text: 'x'.repeat(201), provider_transaction_id: 'full-secret-reference' },
    }).errors).toEqual(expect.arrayContaining([
      'params.text must contain at most 200 characters',
      'params.provider_transaction_id is not accepted for ops.finance.search',
    ]))
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'ops.finance.search', params: { limit: '101' },
    }).errors).toContain('params.limit has an invalid format')
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'ops.audit.detail', params: { source: 'incident', id: 'incident:evt_1' },
    })).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'ops.audit.detail', params: { source: 'payments', id: 'evt_1', raw_payload: '{}' },
    }).errors).toEqual(expect.arrayContaining([
      'params.source has an unsupported value',
      'params.raw_payload is not accepted for ops.audit.detail',
    ]))
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'ops.member.upsert',
      params: { external_subject: 'member_1', role: 'support' },
    }).errors).toContain('params.reason is required')
    expect(validateMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'ops.member.suspend',
      params: { external_subject: 'member_1', reason: 'security review' },
    }).errors).toContain('params.expected_revision is required')
  })
})
