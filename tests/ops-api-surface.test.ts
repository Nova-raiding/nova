import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MCP_METHODS } from '../packages/contracts/src/mcp.js'

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`
    return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/u.test(entry.name) ? [readFileSync(path, 'utf8')] : []
  })
}

function literalRpcMethods(): string[] {
  const source = sourceFiles(new URL('../apps/ops-console/src/', import.meta.url).pathname).join('\n')
  const methods = [...source.matchAll(/\b(?:rpc|optional)\(\s*['"]([^'"]+)['"]/gu)].map(match => match[1]!)
  return [...new Set(methods)]
}

function routeMethods(): string[] {
  const source = readFileSync(new URL('../apps/api/src/server.ts', import.meta.url), 'utf8')
  return [...new Set([...source.matchAll(/case ['"]([^'"]+)['"]\s*:/gu)].map(match => match[1]!))]
}

describe('operations console API surface', () => {
  it('keeps every literal console RPC call in the MCP contract and API router', () => {
    const contract = new Set<string>(MCP_METHODS)
    const routes = new Set(routeMethods())
    const missingFromContract = literalRpcMethods().filter(method => !contract.has(method))
    const missingFromRouter = literalRpcMethods().filter(method => !routes.has(method))
    expect(missingFromContract).toEqual([])
    expect(missingFromRouter).toEqual([])
  })

  it('keeps the MCP contract, policy registry and API dispatch inventory aligned', async () => {
    const { MCP_METHOD_POLICIES, assertMcpMethodPolicyCoverage } = await import('../packages/contracts/src/authz.js')
    const contract = [...MCP_METHODS].sort()
    const policies = Object.keys(MCP_METHOD_POLICIES).sort()
    const routes = routeMethods().filter(method => (MCP_METHODS as readonly string[]).includes(method)).sort()
    expect(assertMcpMethodPolicyCoverage().registered).toBe(MCP_METHODS.length)
    expect(policies).toEqual(contract)
    expect(routes).toEqual(contract)
  })

  it('declares the complete bounded domain and audit-center surface', () => {
    const expected = [
      'ops.support.tickets.list', 'ops.support.ticket.get', 'ops.support.ticket.create',
      'ops.support.ticket.assign', 'ops.support.ticket.transition', 'ops.support.ticket.comment',
      'ops.support.crm.export',
      'ops.incidents.list', 'ops.incident.get', 'ops.incident.timeline', 'ops.incident.create',
      'ops.incident.transition', 'ops.incident.comment', 'ops.incident.commander.assign',
      'ops.incident.scope.update',
      'ops.feature-flags.list', 'ops.feature-flag.upsert', 'ops.feature-flag.emergency.set',
      'ops.feature-flag.events', 'ops.feature-flag.evaluate',
      'ops.finance.search', 'ops.finance.detail', 'ops.finance.export',
      'ops.audit.list', 'ops.audit.detail', 'ops.audit.export',
    ]
    const contract = new Set<string>(MCP_METHODS)
    expect(expected).toHaveLength(26)
    expect(expected.filter(method => !contract.has(method))).toEqual([])
  })

  it('covers the operations domains with routed page components', () => {
    const source = readFileSync(new URL('../apps/ops-console/src/navigation/opsNavigation.ts', import.meta.url), 'utf8')
    for (const domain of ['overview', 'users', 'tasks', 'stores', 'rules', 'models', 'finance', 'audit', 'support', 'incidents', 'feature-flags']) expect(source).toContain(`"${domain}"`)
  })
})
