import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MCP_METHOD_SCHEMAS, MCP_METHODS } from '../packages/contracts/src/mcp.js'
import {
  MCP_LEGACY_OPS_COMMERCIAL_DISABLED_METHODS,
  MCP_POINT_CHARGED_DISABLED_METHODS,
  MCP_POINT_REQUIRED_NO_CHARGE_DISABLED_METHODS,
  MCP_RECOVERY_DISABLED_METHODS,
  MCP_RECOVERY_ENABLED_METHODS,
} from '../packages/contracts/src/commercial-operation-registry.js'

/**
 * Methods the entry skill names that are reachable only when the deployment
 * turns their producer on. Unlike a hidden tool, the skill is not lying: it
 * tells the model to check `tools/list` first and to report the path as
 * unavailable when the tool is absent.
 *
 * Declared here rather than silently skipped, and each entry names the switch
 * that enables it, so the declaration is checkable: the assertions below verify
 * the tool really is absent from the default runtime and that the bridge really
 * does condition it on that switch. If either stops being true the entry is
 * stale and this gate fails.
 */
const CONDITIONALLY_EXPOSED_TOOLS = new Map<string, { enabledBy: string; producer: string }>([
  [
    'multimodal.video.get',
    // Its only input is the provider_job_id returned by multimodal.video.request,
    // so the poller is exactly as reachable as its producer.
    { enabledBy: 'MERCHANT_ENABLE_LOCAL_VIDEO_CANDIDATES', producer: 'multimodal.video.request' },
  ],
])

function methodsFromAllowlist(source: string): string[] {
  const block = source.match(/export const MCP_METHODS = \[(.*?)\]\s+as const/s)?.[1] ?? ''
  return [...block.matchAll(/'([^']+)'/g)].map(match => match[1]!)
}

// The bridge hides/disables methods through two literal sets. Read them from
// the bridge source instead of keeping a third hand-copied snapshot that can
// silently go stale.
function literalSetFromBridge(source: string, name: string): Set<string> {
  const block = source.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`))?.[1] ?? ''
  return new Set([...block.matchAll(/'([^']+)'/g)].map(match => match[1]!))
}

const bridgeSource = readFileSync(new URL('../apps/plugin/mcp/bridge.mjs', import.meta.url), 'utf8')
const merchantHiddenMethods = literalSetFromBridge(bridgeSource, 'MERCHANT_HIDDEN_METHODS')
const commercialDisabledMethods = literalSetFromBridge(bridgeSource, 'COMMERCIAL_DISABLED_METHODS')
const safeWithoutInteractiveWrite = new Set<string>([
  ...literalSetFromBridge(bridgeSource, 'READ_ONLY_METHODS'),
  ...literalSetFromBridge(bridgeSource, 'SAFE_WITHOUT_INTERACTIVE_WRITE'),
])
const destructiveWriteMethods = literalSetFromBridge(bridgeSource, 'DESTRUCTIVE_WRITE_METHODS')
const commercialRecoveryMethods = literalSetFromBridge(bridgeSource, 'COMMERCIAL_RECOVERY_METHODS')

const declaredMerchantToolSurface = new Set(
  MCP_METHODS.filter(method => !method.startsWith('ops.') && !merchantHiddenMethods.has(method) && !commercialDisabledMethods.has(method)),
)

type RuntimeTool = { name: string; inputSchema: { properties?: Record<string, unknown> } }

async function runtimeTools(root: URL): Promise<RuntimeTool[]> {
  const child = spawn(process.execPath, [fileURLToPath(new URL('mcp/bridge.mjs', root))], {
    cwd: fileURLToPath(root),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      MERCHANT_MCP_BASE_URL: 'https://merchant.example.com',
      MERCHANT_WORKSPACE_ID: 'ws_mcp_surface_contract',
      MERCHANT_MCP_WRITE_ENABLED: 'false',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  try {
    return await new Promise<RuntimeTool[]>((resolve, reject) => {
      let buffer = ''
      child.stdout.on('data', chunk => {
        buffer += String(chunk)
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        resolve((JSON.parse(buffer.slice(0, newline)) as { result: { tools: RuntimeTool[] } }).result.tools)
      })
      child.once('error', reject)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })}\n`)
    })
  } finally {
    child.kill()
  }
}

async function runtimeToolNames(root: URL): Promise<string[]> {
  return (await runtimeTools(root)).map(tool => tool.name)
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

describe('MCP surface coverage', () => {
  it('offers Alipay as the only payment channel on every purchasing tool', async () => {
    const paymentMethods = ['subscription.order.create', 'subscription.change', 'billing.recharge.create'] as const
    for (const method of paymentMethods) {
      expect(MCP_METHOD_SCHEMAS[method].properties?.channel).toEqual({ type: 'string', enum: ['alipay'] })
    }

    const runtime = new Map((await runtimeTools(new URL('../apps/plugin/', import.meta.url))).map(tool => [tool.name, tool]))
    for (const method of paymentMethods) {
      if (commercialDisabledMethods.has(method) || merchantHiddenMethods.has(method)) {
        expect(runtime.has(method)).toBe(false)
      } else {
        expect(runtime.get(method)?.inputSchema.properties?.channel).toEqual({ type: 'string', enum: ['alipay'] })
      }
    }
  })

  it('keeps merchant.start intent fields optional, bounded, and fail-closed', () => {
    // The shared contract keeps the integer wire string canonical: the API
    // parses only that shape (apps/api/src/server.ts merchant.start), so
    // widening the contract to numbers would reintroduce a silent drop there.
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
    // The plugin surface must accept both the canonical string and the
    // documented number alias, and must never drop a schema-conformant value.
    // The alias branch is `integer` on purpose: the bridge normalizer only
    // accepts integers, so a `number` branch would let e.g. 5.5 pass validation
    // and then vanish from the forwarded request without any error.
    const bridgeMerchantStart = bridgeSource.match(/^\s*attachment_count: (\{ anyOf: \[.*?\}\])/mu)?.[1] ?? ''
    expect(bridgeMerchantStart).toContain("{ type: 'string', pattern: '^(?:[0-9]|1[0-9]|20)$', maxLength: 2 }")
    expect(bridgeMerchantStart).toContain("{ type: 'integer', minimum: 0, maximum: 20 }")
  })

  it('keeps authoritative docs free of stale fixed merchant-tool counts', () => {
    const merchantMethodCount = declaredMerchantToolSurface.size
    const rootReadme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
    const status = readFileSync(new URL('../doc/todo/quality/implementation-status.md', import.meta.url), 'utf8')
    const pluginReadme = readFileSync(new URL('../apps/plugin/README.md', import.meta.url), 'utf8')
    const installedReadme = readFileSync(new URL('../.codex-marketplace/plugins/merchant-marketing/README.md', import.meta.url), 'utf8')

    expect(installedReadme).toBe(pluginReadme)
    expect(merchantMethodCount).toBeGreaterThan(0)
    expect(rootReadme).not.toMatch(/商家插件当前实测为 \d+ 个 MCP 工具/u)
    expect(status).not.toMatch(/bridge 当前实测为 \d+ 个工具/u)
    expect(pluginReadme).toContain('实际工具以当前连接的 `tools/list` 与运行态契约测试为准')
    expect(pluginReadme).not.toMatch(/tools\/list` (?:实测)?为 \d+ 个 MCP 工具/u)
  })

  it('keeps the merchant hidden/disabled sets resolvable against the allowlist and the runtime tools/list', async () => {
    for (const method of [...merchantHiddenMethods, ...commercialDisabledMethods]) {
      expect(MCP_METHODS, `${method} is filtered by the bridge but is not an allowlisted MCP method`).toContain(method)
    }
    // The bridge may narrow the merchant surface below the server, but every
    // commercial operation the shared registry disables must also be disabled
    // at the bridge, otherwise the plugin would forward a known-dead request.
    const registryDisabled = [
      ...MCP_LEGACY_OPS_COMMERCIAL_DISABLED_METHODS,
      ...MCP_RECOVERY_DISABLED_METHODS,
      ...MCP_POINT_CHARGED_DISABLED_METHODS,
      ...MCP_POINT_REQUIRED_NO_CHARGE_DISABLED_METHODS,
    ]
    expect(registryDisabled.filter(method => !commercialDisabledMethods.has(method)), 'bridge re-enables a method the shared registry disables').toEqual([])
    const runtimeNames = await runtimeToolNames(new URL('../apps/plugin/', import.meta.url))
    const declared = [...declaredMerchantToolSurface].sort()
    expect(declared.length).toBeGreaterThan(0)
    // Drift guard: what the bridge declares it exposes must be exactly what
    // tools/list returns. A stale hidden/disabled entry (or a missing one)
    // breaks this, so the merchant surface can never silently shrink or grow.
    expect([...runtimeNames].sort()).toEqual(declared)
    expect(runtimeNames.some(name => name.startsWith('ops.'))).toBe(false)
  })

  it('never declares a tools/list argument the authoritative contract would reject', async () => {
    // The bridge schema is what the model actually sees, so a declared argument
    // the contract does not accept is a deterministic 400: validateMcpRequest
    // rejects `params.<key> is not accepted for <method>` before any handler can
    // run. Checking tool names alone (the entry-skill test above) cannot catch
    // that subclass; this test closes it.
    const tools = await runtimeTools(new URL('../apps/plugin/', import.meta.url))
    expect(tools.length).toBeGreaterThan(0)
    // asset.upload.file_path is the single bridge-local argument: the bridge
    // itself reads the merchant-attached file and drops the key in
    // prepareToolArguments, so the server contract must NOT accept it. Pinning
    // it here keeps the exception explicit: any other undeclared argument fails.
    const bridgeLocalArguments: Readonly<Record<string, readonly string[]>> = {
      'asset.upload': ['file_path'],
    }
    for (const [method, locals] of Object.entries(bridgeLocalArguments)) {
      const tool = tools.find(candidate => candidate.name === method)
      expect(tool, `${method} must stay on the merchant surface`).toBeDefined()
      for (const local of locals) {
        expect(tool?.inputSchema.properties, `${method}.${local} must stay declared`).toHaveProperty(local)
        // A declared-but-forwarded local argument is exactly the drift that
        // produces the API 400, so the stripping step must still exist.
        expect(bridgeSource, `${method}.${local} is no longer stripped by the bridge`).toContain(`delete prepared.${local}`)
      }
    }
    const contractSchemas = MCP_METHOD_SCHEMAS as Readonly<Record<string, { properties?: Record<string, unknown> }>>
    const undeclared: string[] = []
    for (const tool of tools) {
      const schema = contractSchemas[tool.name]
      if (!schema) { undeclared.push(`${tool.name} (no contract)`); continue }
      const accepted = new Set(Object.keys(schema.properties ?? {}))
      const locals = new Set(bridgeLocalArguments[tool.name] ?? [])
      for (const property of Object.keys(tool.inputSchema.properties ?? {})) {
        if (!accepted.has(property) && !locals.has(property)) undeclared.push(`${tool.name}.${property}`)
      }
    }
    expect(undeclared, `bridge declares arguments validateMcpRequest would reject: ${undeclared.join(', ')}`).toEqual([])
  })

  it('never lets a destructive write bypass the interactive merchant consent gate', () => {
    const overlap = [...destructiveWriteMethods].filter(method => safeWithoutInteractiveWrite.has(method))
    expect(overlap, `destructive tools exempted from workspace.interactive.confirm: ${overlap.join(', ')}`).toEqual([])
    // The consent gate is the only merchant approval on the stdio plugin path,
    // so the destructive classification itself must stay populated.
    expect(destructiveWriteMethods.has('workspace.data.delete.request')).toBe(true)
    expect(destructiveWriteMethods.has('workspace.deactivate')).toBe(true)
    expect(destructiveWriteMethods.has('catalog.product.disable')).toBe(true)
    expect(safeWithoutInteractiveWrite.has('workspace.data.export.request')).toBe(true)
  })

  it('keeps the bridge zero-point recovery allowlist equal to the shared commercial registry', () => {
    const registry: string[] = [...MCP_RECOVERY_ENABLED_METHODS]
    const bridge = [...commercialRecoveryMethods]
    expect(bridge.filter(method => !registry.includes(method)), 'bridge allows recovery methods the server does not').toEqual([])
    expect(registry.filter(method => !bridge.includes(method)), 'bridge blocks recovery methods the server allows').toEqual([])
    expect(bridge).toEqual(registry)
  })

  it('keeps every tool named by the entry skill reachable through tools/list', async () => {
    const runtimeTools = new Set(await runtimeToolNames(new URL('../apps/plugin/', import.meta.url)))
    const rootReadme = readFileSync(new URL('../apps/plugin/skills/merchant-marketing/SKILL.md', import.meta.url), 'utf8')
    const installedSkill = readFileSync(new URL('../.codex-marketplace/plugins/merchant-marketing/skills/merchant-marketing/SKILL.md', import.meta.url), 'utf8')
    expect(installedSkill).toBe(rootReadme)
    const allowlisted = new Set<string>(MCP_METHODS)
    const tokens = new Set([...rootReadme.matchAll(/`([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+)`/gu)].map(match => match[1]!))
    expect(tokens.size).toBeGreaterThan(0)
    for (const token of tokens) {
      // Tool-shaped tokens must be reachable. Tokens that are not MCP methods
      // at all (permissions such as customer.content.update, artifact names
      // such as review-findings.json) are documentation, not tool calls.
      if (!allowlisted.has(token)) continue
      const conditional = CONDITIONALLY_EXPOSED_TOOLS.get(token)
      if (conditional) {
        // A declared conditional tool must actually be conditional: absent by
        // default, and gated in the bridge on the switch named here. That is
        // what keeps this declaration from decaying into a plain allowlist.
        expect(runtimeTools.has(token), `${token} is declared conditional but the default runtime exposes it; the declaration is stale`).toBe(false)
        const bridgeSource = readFileSync(new URL('../apps/plugin/mcp/bridge.mjs', import.meta.url), 'utf8')
        expect(bridgeSource, `${token} is declared conditional on ${conditional.enabledBy}, but the bridge never mentions it`).toContain(conditional.enabledBy)
        expect(bridgeSource, `${token} is declared conditional but the bridge never mentions its producer ${conditional.producer}`).toContain(conditional.producer)
        continue
      }
      expect(runtimeTools.has(token), `SKILL.md tells the model to use ${token}, but the bridge does not expose it`).toBe(true)
    }
  })

  it('keeps the 23 domain methods and four audit-center reads on the declared surface', () => {
    const opsDomainMethods = MCP_METHODS.filter(method =>
      method.startsWith('ops.support.')
      || method.startsWith('ops.incident')
      || method.startsWith('ops.feature-flag')
      || method.startsWith('ops.finance.'),
    )
    expect(opsDomainMethods).toHaveLength(25)
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
    expect(apiDockerfile).not.toContain('COPY --from=build /app/apps/plugin ./apps/plugin')
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
