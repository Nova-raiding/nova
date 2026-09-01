import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MCP_METHOD_SCHEMAS, MCP_METHODS } from '../packages/contracts/src/mcp.js'

function methodsFromAllowlist(source: string): string[] {
  const block = source.match(/export const MCP_METHODS = \[(.*?)\]\s+as const/s)?.[1] ?? ''
  return [...block.matchAll(/'([^']+)'/g)].map(match => match[1]!)
}

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
const merchantHiddenMethods = new Set([
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
const commercialDisabledMethods = new Set([
  'ops.commercial.offers.list', 'ops.commercial.offer.upsert', 'ops.commercial.addons.list', 'ops.commercial.addon.upsert',
  'ops.commercial.coupons.list', 'ops.commercial.export', 'ops.commercial.coupon.upsert', 'ops.commercial.rollouts.list',
  'ops.commercial.rollout.upsert', 'ops.commercial.model-markup.get', 'ops.commercial.model-markup.update',
  'subscription.order.create', 'subscription.change', 'billing.recharge.create', 'catalog.image.generate',
  'multimodal.image.edit', 'ops.marketing.generation.retry', 'merchant.first_value',
  'campaign.batch.generate', 'campaign.batch.retry_failed', 'catalog.title.optimize', 'catalog.image.retry',
  'brand.extract', 'brand.tone.preview', 'task.understand', 'creative.directions', 'creative.brief', 'creative.preview',
  'content.generate', 'content.codex.prepare', 'content.codex.commit', 'content.review', 'content.modify',
  'automation.scan', 'automation.tick', 'multimodal.generate', 'multimodal.video.request', 'workspace.commercial.get',
  'workspace.commercial.update', 'workspace.usage.get', 'billing.usage.consume', 'billing.usage.refund', 'billing.refund',
])

describe('MCP surface coverage', () => {
  it('keeps merchant.start intent fields optional, bounded, and fail-closed', () => {
    expect(MCP_METHOD_SCHEMAS['merchant.start']).toMatchObject({
      additionalProperties: false,
      properties: {
        requested_platform: { enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] },
        requested_goal: { minLength: 1, maxLength: 2_000 },
        attachment_count: { type: 'string', pattern: '^(?:[0-9]|1[0-9]|20)$', maxLength: 2 },
        idempotency_key: { minLength: 8, maxLength: 200, pattern: '^[A-Za-z0-9._:-]+$' },
      },
    })
    expect(MCP_METHOD_SCHEMAS['merchant.start'].required).toBeUndefined()
  })

  it('keeps current API and merchant-tool counts aligned across authoritative docs', () => {
    const merchantMethodCount = MCP_METHODS.filter(method =>
      !method.startsWith('ops.') && !merchantHiddenMethods.has(method) && !commercialDisabledMethods.has(method),
    ).length
    const rootReadme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
    const status = readFileSync(new URL('../doc/todo/quality/implementation-status.md', import.meta.url), 'utf8')
    const pluginReadme = readFileSync(new URL('../apps/plugin/README.md', import.meta.url), 'utf8')
    const installedReadme = readFileSync(new URL('../.codex-marketplace/plugins/merchant-marketing/README.md', import.meta.url), 'utf8')

    expect(installedReadme).toBe(pluginReadme)
    expect(rootReadme).toContain(`MCP 契约注册表为 ${MCP_METHODS.length} 个唯一方法，商家插件运行态为 ${merchantMethodCount} 个 MCP 工具`)
    expect(status).toContain(`源码为 ${MCP_METHODS.length} 个唯一 MCP 方法、${merchantMethodCount} 个商家 bridge 工具`)
    expect(pluginReadme).toContain(`tools/list\` 为 ${merchantMethodCount} 个 MCP 工具`)
  })

  it('keeps the 23 domain methods and four audit-center reads on the declared surface', () => {
    const opsDomainMethods = MCP_METHODS.filter(method =>
      method.startsWith('ops.support.')
      || method.startsWith('ops.incident')
      || method.startsWith('ops.feature-flag')
      || method.startsWith('ops.finance.'),
    )
    expect(opsDomainMethods).toHaveLength(26)
    expect(MCP_METHODS.filter(method => method.startsWith('ops.audit.'))).toEqual([
      'ops.audit.list', 'ops.audit.platform.list', 'ops.audit.detail', 'ops.audit.export',
    ])
  })

  it('keeps every allowlisted method represented by API/OpenAPI while hiding operations tools from the merchant plugin', () => {
    const internalOperationsMethods = new Set(['billing.model-usage.reconciliation.run', 'billing.model-usage.resolve'])
    const contracts = readFileSync(new URL('../packages/contracts/src/mcp.ts', import.meta.url), 'utf8')
    const api = readFileSync(new URL('../apps/api/src/server.ts', import.meta.url), 'utf8')
    const openapi = readFileSync(new URL('../apps/api/openapi.yaml', import.meta.url), 'utf8')
    const bridge = readFileSync(new URL('../apps/plugin/mcp/bridge.mjs', import.meta.url), 'utf8')
    const installedBridge = readFileSync(new URL('../.codex-marketplace/plugins/merchant-marketing/mcp/bridge.mjs', import.meta.url), 'utf8')
    expect(installedBridge).toBe(bridge)
    expect(methodsFromAllowlist(contracts)).toEqual([...MCP_METHODS])
    for (const method of MCP_METHODS) {
      expect(api.includes(`case '${method}'`) || api.includes(`method === '${method}'`), `${method} missing API route`).toBe(true)
      if (!method.startsWith('ops.') && !internalOperationsMethods.has(method)) {
        expect(bridge.includes(`'${method}':`), `${method} missing bridge definition`).toBe(true)
        expect(installedBridge.includes(`'${method}':`), `${method} missing installed bridge definition`).toBe(true)
      }
    }
    expect(bridge).toContain('filter(([name]) => isMerchantTool(name) && !COMMERCIAL_DISABLED_METHODS.has(name))')
    expect(bridge).toContain('!isMerchantTool(name) || !METHODS[name]')
    expect(installedBridge).toContain('filter(([name]) => isMerchantTool(name) && !COMMERCIAL_DISABLED_METHODS.has(name))')
    expect(installedBridge).toContain('!isMerchantTool(name) || !METHODS[name]')
  })

  it('keeps the production-evidence methods unique and byte-identical across plugin surfaces', () => {
    const contracts = readFileSync(new URL('../packages/contracts/src/mcp.ts', import.meta.url), 'utf8')
    const openapi = readFileSync(new URL('../apps/api/openapi.yaml', import.meta.url), 'utf8')
    const bridge = readFileSync(new URL('../apps/plugin/mcp/bridge.mjs', import.meta.url), 'utf8')
    const installedBridge = readFileSync(new URL('../.codex-marketplace/plugins/merchant-marketing/mcp/bridge.mjs', import.meta.url), 'utf8')
    const apiDockerfile = readFileSync(new URL('../infra/docker/api.Dockerfile', import.meta.url), 'utf8')
    expect(installedBridge).toBe(bridge)
    expect(apiDockerfile).toContain('COPY --from=build /app/apps/plugin ./apps/plugin')
    expect(new Set(MCP_METHODS).size).toBe(MCP_METHODS.length)
    for (const method of productionEvidenceMethods) {
      expect(methodsFromAllowlist(contracts).filter(candidate => candidate === method), `${method} duplicated in allowlist`).toHaveLength(1)
      expect([...bridge.matchAll(new RegExp(`^  '${method.replaceAll('.', '\\.')}'\\s*:`, 'gmu'))], `${method} duplicated in source bridge`).toHaveLength(1)
      expect([...installedBridge.matchAll(new RegExp(`^  '${method.replaceAll('.', '\\.')}'\\s*:`, 'gmu'))], `${method} duplicated in marketplace bridge`).toHaveLength(1)
      expect(openapi).toContain(`${method}: '#/components/schemas/`)
    }
  })

  it('keeps campaign controls unique across API, OpenAPI, source bridge, and installed bridge', () => {
    const contracts = readFileSync(new URL('../packages/contracts/src/mcp.ts', import.meta.url), 'utf8')
    const api = readFileSync(new URL('../apps/api/src/server.ts', import.meta.url), 'utf8')
    const openapi = readFileSync(new URL('../apps/api/openapi.yaml', import.meta.url), 'utf8')
    const bridge = readFileSync(new URL('../apps/plugin/mcp/bridge.mjs', import.meta.url), 'utf8')
    const installedBridge = readFileSync(new URL('../.codex-marketplace/plugins/merchant-marketing/mcp/bridge.mjs', import.meta.url), 'utf8')
    expect(installedBridge).toBe(bridge)
    for (const method of campaignControlMethods) {
      expect(methodsFromAllowlist(contracts).filter(candidate => candidate === method), `${method} duplicated in allowlist`).toHaveLength(1)
      expect(api.includes(`case '${method}'`) || api.includes(`method === '${method}'`), `${method} missing API route`).toBe(true)
      expect([...bridge.matchAll(new RegExp(`^  '${method.replaceAll('.', '\\.')}'\\s*:`, 'gmu'))], `${method} duplicated in source bridge`).toHaveLength(1)
      expect([...installedBridge.matchAll(new RegExp(`^  '${method.replaceAll('.', '\\.')}'\\s*:`, 'gmu'))], `${method} duplicated in installed bridge`).toHaveLength(1)
      const schema = method === 'campaign.batch.retry_failed' ? 'McpCampaignBatchRetryFailedParams' : 'McpCampaignBatchControlParams'
      expect(openapi).toContain(`${method}: '#/components/schemas/${schema}'`)
    }
  })

  it('keeps multi-target campaign and reverse product-asset relations reachable across surfaces', () => {
    const contracts = readFileSync(new URL('../packages/contracts/src/mcp.ts', import.meta.url), 'utf8')
    const api = readFileSync(new URL('../apps/api/src/server.ts', import.meta.url), 'utf8')
    const openapi = readFileSync(new URL('../apps/api/openapi.yaml', import.meta.url), 'utf8')
    const bridge = readFileSync(new URL('../apps/plugin/mcp/bridge.mjs', import.meta.url), 'utf8')
    const ui = readFileSync(new URL('../demo/merchant-studio/src/api.ts', import.meta.url), 'utf8')

    for (const method of ['brand-unit.product.create', 'brand-unit.listing.create', 'brand-unit.listing.list', 'campaign.batch.create', 'campaign.batch.generate', 'publish.batch.prepare', 'publish.batch.confirm']) {
      expect(contracts).toContain(`method: '${method}'`)
      expect(api).toContain(`case '${method}'`)
      expect(bridge).toContain(`'${method}':`)
    }
    for (const method of ['brand-unit.product.create', 'brand-unit.listing.create', 'brand-unit.listing.list', 'campaign.batch.create', 'campaign.batch.generate', 'publish.batch.prepare', 'publish.batch.confirm']) expect(openapi).toContain(method)
    for (const field of ['canonical_product_id', 'listing_id', 'expected_revision', 'idempotency_key']) {
      expect(contracts).toContain(field)
      expect(bridge).toContain(field)
      expect(api).toContain(field)
    }
    expect(api).toContain('productAssetsMatch = path.match')
    expect(api).toContain('assetProductsMatch = path.match')
    expect(openapi).toContain('/v1/products/{productId}/assets:')
    expect(openapi).toContain('/v1/assets/{assetId}/products:')
    expect(ui).toContain('/v1/products/${encodeURIComponent(productId)}/assets')
    expect(ui).toContain('/v1/assets/${encodeURIComponent(assetId)}/products')
    for (const field of ['asset_id', 'brand_id', 'expected_version', 'asset_role', 'ordinal']) expect(openapi).toContain(`${field}:`)
  })

  it('keeps preflight, batch target identity, reverse asset lookup, and customer-data permissions aligned', () => {
    const contracts = readFileSync(new URL('../packages/contracts/src/mcp.ts', import.meta.url), 'utf8')
    const api = readFileSync(new URL('../apps/api/src/server.ts', import.meta.url), 'utf8')
    const openapi = readFileSync(new URL('../apps/api/openapi.yaml', import.meta.url), 'utf8')
    const bridge = readFileSync(new URL('../apps/plugin/mcp/bridge.mjs', import.meta.url), 'utf8')
    const studioApi = readFileSync(new URL('../demo/merchant-studio/src/api.ts', import.meta.url), 'utf8')
    const studioReadiness = readFileSync(new URL('../demo/merchant-studio/src/DeliveryReadinessPanel.tsx', import.meta.url), 'utf8')
    const studioCampaign = readFileSync(new URL('../demo/merchant-studio/src/CampaignLifecyclePanel.tsx', import.meta.url), 'utf8')
    const opsCampaign = readFileSync(new URL('../apps/ops-console/src/components/tasks/knowledge/CampaignLifecycleControl.tsx', import.meta.url), 'utf8')

    expect(contracts).toContain("method: 'platform.mapping.preflight'")
    expect(api).toContain("case 'platform.mapping.preflight'")
    expect(bridge).toContain("'platform.mapping.preflight':")
    expect(openapi).toContain("platform.mapping.preflight: '#/components/schemas/McpPlatformMappingPreflightParams'")
    expect(api).toContain('PLATFORM_MAPPING_PREFLIGHT_REQUIRED')
    expect(studioApi).toContain("'platform.mapping.preflight'")
    expect(studioApi).toContain('evaluatePlatformMappingPreflight')
    expect(studioReadiness).toContain('mappingPreflights')
    expect(studioReadiness).toContain('nextAction')

    for (const source of [studioCampaign, opsCampaign]) {
      expect(source).toContain('platform')
      expect(source).toContain('accountId')
      expect(source).toContain('expected_revision')
      expect(source).toContain('idempotency_key')
    }
    expect(studioApi).toContain('/v1/products/${encodeURIComponent(productId)}/assets')
    expect(studioApi).toContain('/v1/assets/${encodeURIComponent(assetId)}/products')

    expect(api).toContain('function requireWorkspaceDataRole')
    expect(api).toContain("['workspace_owner', 'merchant_admin', 'operator', 'support']")
    expect(api).not.toMatch(/function requireWorkspaceDataRole[\\s\\S]{0,300}platform_ops/u)
  })

  it('keeps video evidence and model usage settlement fields aligned across relay surfaces', () => {
    const contracts = readFileSync(new URL('../packages/contracts/src/mcp.ts', import.meta.url), 'utf8')
    const api = readFileSync(new URL('../apps/api/src/server.ts', import.meta.url), 'utf8')
    const openapi = readFileSync(new URL('../apps/api/openapi.yaml', import.meta.url), 'utf8')
    const bridge = readFileSync(new URL('../apps/plugin/mcp/bridge.mjs', import.meta.url), 'utf8')
    const installedBridge = readFileSync(new URL('../.codex-marketplace/plugins/merchant-marketing/mcp/bridge.mjs', import.meta.url), 'utf8')
    const video = readFileSync(new URL('../packages/multimodal/src/video-storyboard-quality.ts', import.meta.url), 'utf8')
    const relayUsage = readFileSync(new URL('../packages/ai/src/relay-usage.ts', import.meta.url), 'utf8')
    const usageRepository = readFileSync(new URL('../packages/persistence/src/model-usage-repository.ts', import.meta.url), 'utf8')
    const opsTypes = readFileSync(new URL('../apps/ops-console/src/types/ops.ts', import.meta.url), 'utf8')

    for (const method of ['multimodal.video.request', 'multimodal.video.get']) {
      expect(contracts).toContain(`method: '${method}'`)
      expect(api).toContain(`case '${method}'`)
      expect(bridge).toContain(`'${method}':`)
      expect(openapi).toContain(method)
    }
    for (const field of ['context_json', 'idempotency_key', 'provider_job_id']) expect(bridge).toContain(field)
    for (const field of ['completionEvidence', 'artifactRef', 'checksum']) expect(video).toContain(field)
    expect(installedBridge).toBe(bridge)

    for (const field of ['workspaceId', 'actionId', 'receiptKey', 'providerRequestId', 'inputTokens', 'outputTokens', 'totalTokens', 'costCny']) {
      expect(relayUsage).toContain(field)
      expect(usageRepository).toContain(field)
    }
    for (const field of ['settlement_status', 'customer_charge_cny', 'provider_request_id', 'allowed_decisions', 'revision']) expect(opsTypes).toContain(field)
    expect(api).toContain('model_usage_ledger')
    expect(api).toContain('markupMultiplier')
    expect(api).toContain('customerChargeCny')
  })

  it('does not retain the obsolete eight-capability display copy', () => {
    const app = readFileSync(new URL('../demo/merchant-studio/src/App.tsx', import.meta.url), 'utf8')
    expect(app).not.toContain('/8 canary')
    expect(app).not.toContain('fetchPlatformCapabilities(baseUrl)')
    expect(app).toContain('平台能力证据属于平台运营工作台')
  })
})
