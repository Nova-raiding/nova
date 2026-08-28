import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MCP_METHODS } from '../packages/contracts/src/mcp.js'

function methodsFromAllowlist(source: string): string[] {
  const block = source.match(/export const MCP_METHODS = \[(.*?)\]\s+as const/s)?.[1] ?? ''
  return [...block.matchAll(/'([^']+)'/g)].map(match => match[1]!)
}

describe('MCP surface coverage', () => {
  it('keeps every allowlisted method represented by API/OpenAPI while hiding operations tools from the merchant plugin', () => {
    const internalOperationsMethods = new Set(['billing.model-usage.reconciliation.run', 'billing.model-usage.resolve'])
    const contracts = readFileSync(new URL('../packages/contracts/src/mcp.ts', import.meta.url), 'utf8')
    const api = readFileSync(new URL('../apps/api/src/server.ts', import.meta.url), 'utf8')
    const openapi = readFileSync(new URL('../apps/api/openapi.yaml', import.meta.url), 'utf8')
    const bridge = readFileSync(new URL('../apps/plugin/mcp/bridge.mjs', import.meta.url), 'utf8')
    const installedBridge = readFileSync(new URL('../.codex-marketplace/plugins/merchant-marketing/mcp/bridge.mjs', import.meta.url), 'utf8')
    expect(methodsFromAllowlist(contracts)).toEqual([...MCP_METHODS])
    for (const method of MCP_METHODS) {
      expect(api.includes(`case '${method}'`) || api.includes(`method === '${method}'`), `${method} missing API route`).toBe(true)
      if (!method.startsWith('ops.') && !internalOperationsMethods.has(method)) {
        expect(bridge.includes(`'${method}':`), `${method} missing bridge definition`).toBe(true)
        expect(installedBridge.includes(`'${method}':`), `${method} missing installed bridge definition`).toBe(true)
      }
      expect(openapi.includes(method), `${method} missing OpenAPI allowlist`).toBe(true)
    }
    expect(bridge).toContain('filter(([name]) => isMerchantTool(name))')
    expect(bridge).toContain('!isMerchantTool(name) || !METHODS[name]')
    expect(installedBridge).toContain('filter(([name]) => isMerchantTool(name))')
    expect(installedBridge).toContain('!isMerchantTool(name) || !METHODS[name]')
  })

  it('does not retain the obsolete eight-capability display copy', () => {
    const app = readFileSync(new URL('../demo/merchant-studio/src/App.tsx', import.meta.url), 'utf8')
    expect(app).not.toContain('/8 canary')
    expect(app).toContain('{canaryCount}/{item.capabilities.length} canary')
  })
})
