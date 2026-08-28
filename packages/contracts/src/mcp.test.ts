import { describe, expect, it } from 'vitest'
import {
  MCP_METHOD_CONTRACTS,
  MCP_METHODS,
  MCP_METHOD_SCHEMAS,
  getMcpMethodContract,
  isMcpMethod,
  validateMcpRequest,
} from './index.js'

describe('MCP method contract', () => {
  it('keeps the legacy methods and exposes the complete merchant workflow', () => {
    expect(MCP_METHODS.filter(method => !['workspace.interactive.confirm', 'task.resume', 'catalog.title.accept', 'catalog.sku.update', 'catalog.product.update', 'ops.marketing.queue.assign', 'ops.marketing.visual.review', 'automation.tick', 'ops.session', 'brand-unit.list', 'brand-unit.create', 'brand-unit.bind-store', 'brand-unit.product.create', 'brand-unit.listing.create', 'brand-unit.listing.list', 'campaign.batch.create', 'campaign.batch.get', 'campaign.batch.generate'].includes(method)).filter(method => !method.startsWith('ops.commercial.model-markup.'))).toEqual(expect.arrayContaining([
      'merchant.start', 'merchant.first_value', 'workspace.health', 'workspace.bootstrap', 'workspace.metrics', 'workspace.commercial.get', 'workspace.commercial.update', 'workspace.usage.get', 'ops.audit.list', 'ops.audit.export', 'ops.data.delete.list', 'ops.data.delete.cancel', 'ops.data.delete.approve', 'ops.members.list', 'ops.workspaces.list', 'ops.commercial.offers.list', 'ops.commercial.offer.upsert', 'ops.commercial.addons.list', 'ops.commercial.addon.upsert', 'ops.commercial.coupons.list', 'ops.commercial.coupon.upsert', 'ops.commercial.rollouts.list', 'ops.commercial.rollout.upsert', 'ops.growth.funnel', 'ops.alerts.list', 'ops.alert.ack', 'ops.marketing.queue', 'ops.marketing.generation.retry', 'ops.marketing.publish.acknowledge', 'ops.marketing.revision.create', 'ops.member.upsert', 'ops.member.suspend', 'subscription.get', 'subscription.orders.list', 'subscription.order.create', 'subscription.change', 'billing.usage.consume', 'billing.usage.refund', 'billing.refund', 'billing.reconciliation', 'billing.reconciliation.run', 'billing.export', 'platform.settings.get', 'platform.settings.update', 'platform.model.status', 'billing.status', 'billing.recharge.create', 'billing.recharge.get', 'billing.transactions', 'workspace.deactivate', 'workspace.activate', 'workspace.data.delete.request', 'platform.connect', 'platform.store.alias.set', 'catalog.search', 'catalog.categories', 'catalog.title.optimize', 'catalog.import', 'catalog.import.batch', 'catalog.facts.confirm', 'catalog.product.disable', 'catalog.product.enable', 'catalog.image.generate', 'catalog.image.get', 'catalog.image.review', 'sync.retry_failed', 'rule.list', 'rule.sync.status', 'rule.history', 'rule.audit', 'rule.publish', 'rule.status', 'asset.list', 'asset.parse', 'asset.facts.confirm', 'asset.preference.update', 'brand.get', 'brand.extract', 'brand.upsert', 'brand.tone.preview', 'asset.upload', 'asset.upload.batch', 'asset.scan', 'asset.rights.update', 'catalog.sync', 'catalog.sync.start', 'catalog.sync.get', 'deliverable.list', 'task.history', 'task.clone', 'task.timeline', 'feedback.list', 'feedback.submit', 'platform.revoke', 'task.create', 'task.answer', 'task.understand', 'task.request.create', 'task.sku.split', 'task.group.create',
      'creative.directions', 'creative.brief', 'creative.preview', 'creative.directions.update', 'task.select_direction', 'task.plan.confirm', 'content.generate', 'content.codex.prepare', 'content.codex.commit', 'generation.get', 'content.review', 'content.review.decide', 'content.visual.select',
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
    expect(MCP_METHODS).toContain('ops.commercial.model-markup.get')
    expect(MCP_METHODS).toContain('ops.commercial.model-markup.update')
    expect(MCP_METHODS).toContain('ops.user.detail')
    expect(MCP_METHODS).toContain('ops.user.risk.transition')
    expect(MCP_METHODS).toContain('ops.user.session.revoke')
    expect(MCP_METHODS).toContain('billing.model-usage.reconciliation.run')
    expect(MCP_METHODS).toContain('billing.model-usage.resolve')
  })

  it('rejects methods outside the allowlist', () => {
    expect(isMcpMethod('admin.raw_sql')).toBe(false)
  })

  it('defines an explicit parameter schema for every method', () => {
    expect(MCP_METHOD_CONTRACTS).toHaveLength(MCP_METHODS.length)
    for (const method of MCP_METHODS) {
      expect(MCP_METHOD_SCHEMAS[method]).toMatchObject({ type: 'object', additionalProperties: false })
    }
    expect(MCP_METHOD_SCHEMAS['task.create'].required).toEqual(['product_id', 'platform'])
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
    expect(MCP_METHOD_SCHEMAS['merchant.first_value']).toEqual({
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] },
        account_id: { type: 'string' },
        product_id: { type: 'string' },
        example: { type: 'string', enum: ['true'] },
      },
      additionalProperties: false,
    })
    expect(MCP_METHOD_SCHEMAS['merchant.first_value'].required).toBeUndefined()
    expect(getMcpMethodContract('merchant.first_value')?.description).toMatch(/safe first-value preview bundle.*never publishes.*does not call a model unless the server explicitly says/iu)
    expect(MCP_METHOD_SCHEMAS['brand-unit.bind-store'].required).toEqual(['brand_id', 'platform', 'account_id'])
    expect(MCP_METHOD_SCHEMAS['campaign.batch.create'].required).toEqual(['brand_id'])
    expect(MCP_METHOD_SCHEMAS['campaign.batch.create'].properties.product_ids_json).toEqual({ type: 'string' })
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
  })

  it('accepts valid requests and rejects malformed or over-permissive params', () => {
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
  })
})
