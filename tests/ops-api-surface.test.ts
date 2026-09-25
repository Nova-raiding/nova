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

/**
 * Every MCP method the API router dispatches.
 *
 * Scoped to the `switch (method)` block on purpose. Matching every `case` label
 * in the file instead made this inventory pick up unrelated switches: adding a
 * `switch (item.state)` with `case 'approved':` elsewhere in server.ts grew the
 * method list from 328 to 332 and failed this gate for a reason that had
 * nothing to do with the console surface.
 */
function routeMethods(): string[] {
  const source = readFileSync(new URL('../apps/api/src/server.ts', import.meta.url), 'utf8')
  const directory = new URL('../apps/api/src/', import.meta.url)
  const importedHandlers = new Map<string, string>()
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/(mcp-[^']+-handlers)\.js'/gu)) {
    const handler = readFileSync(new URL(`${match[2]}.ts`, directory), 'utf8')
    for (const symbol of match[1]!.split(',').map(part => part.trim().split(/\s+as\s+/u)[0]!.trim())) {
      importedHandlers.set(symbol, handler)
    }
  }
  const lines = source.split('\n')
  const switchLine = lines.findIndex(line => /^\s+switch \(method\) \{\s*$/u.test(line))
  if (switchLine < 0) throw new Error('the MCP dispatch switch must stay recognizable')
  let depth = 0
  let end = lines.length
  for (let index = switchLine; index < lines.length; index += 1) {
    for (const character of lines[index]!) {
      if (character === '{') depth += 1
      else if (character === '}') { depth -= 1; if (depth === 0) { end = index; break } }
    }
    if (end !== lines.length) break
  }
  const methods = lines
    .slice(switchLine, end)
    .flatMap(line => [...line.matchAll(/case ['"]([^'"]+)['"]\s*:/gu)].map(match => match[1]!))
  // Before the switch, some domains dispatch through an imported method Set.
  // Read the actual Set declaration rather than treating every method check in
  // its handler as a second route (the switch-based handlers have both).
  const guardedMethods = [...source.slice(source.indexOf('async function routeMcp'), source.indexOf('switch (method)')).matchAll(/\b([A-Z][A-Z0-9_]*METHODS)\.has\(method\)/gu)]
    .filter(match => importedHandlers.has(match[1]!))
    .flatMap(match => {
    const symbol = match[1]!
    const handler = importedHandlers.get(symbol)
    if (!handler) throw new Error(`MCP guard ${symbol} has no imported handler`)
    const declaration = handler.match(new RegExp(`export const ${symbol} = new Set\\(\\[([\\s\\S]*?)\\]\\)`, 'u'))
    if (!declaration) throw new Error(`MCP guard ${symbol} has no literal method Set`)
    return [...declaration[1]!.matchAll(/['"]([^'"]+)['"]/gu)].map(item => item[1]!)
  })
  const all = [...methods, ...guardedMethods]
  expect(new Set(all).size, 'each MCP method needs one dispatch branch').toBe(all.length)
  const routed = new Set(all)
  // Every imported handler participates in this audit. Its method literals
  // must be reachable through either a switch case or an imported Set guard.
  for (const handler of new Set(importedHandlers.values())) {
    const implemented = [...handler.matchAll(/\bcase '([^']+)'\s*:|\bmethod === '([^']+)'/gu)]
      .map(match => match[1] ?? match[2]!)
      .filter(method => MCP_METHODS.includes(method as typeof MCP_METHODS[number]))
    expect(implemented.filter(method => !routed.has(method))).toEqual([])
  }
  return all
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
    const routes = routeMethods().sort()
    expect(assertMcpMethodPolicyCoverage().registered).toBe(MCP_METHODS.length)
    expect(policies).toEqual(contract)
    expect(routes).toEqual(contract)
  })

  it('declares the complete bounded domain and audit-center surface', () => {
    const expected = [
      'ops.support.tickets.list', 'ops.support.ticket.get', 'ops.support.ticket.create',
      'ops.support.ticket.assign', 'ops.support.ticket.transition', 'ops.support.ticket.comment',
      'ops.incidents.list', 'ops.incident.get', 'ops.incident.timeline', 'ops.incident.create',
      'ops.incident.transition', 'ops.incident.comment', 'ops.incident.commander.assign',
      'ops.incident.scope.update',
      'ops.feature-flags.list', 'ops.feature-flag.upsert', 'ops.feature-flag.emergency.set',
      'ops.feature-flag.events', 'ops.feature-flag.evaluate',
      'ops.finance.search', 'ops.finance.detail', 'ops.finance.export',
      'ops.audit.list', 'ops.audit.detail', 'ops.audit.export',
    ]
    const contract = new Set<string>(MCP_METHODS)
    expect(expected).toHaveLength(25)
    expect(expected.filter(method => !contract.has(method))).toEqual([])
  })

  it('covers the operations domains with routed page components', () => {
    const source = readFileSync(new URL('../apps/ops-console/src/navigation/opsNavigation.ts', import.meta.url), 'utf8')
    for (const domain of ['overview', 'users', 'customer-delivery', 'members', 'tasks', 'knowledge', 'stores', 'rules', 'models', 'storage', 'finance', 'audit']) expect(source).toContain(`"${domain}"`)
    expect(source).not.toContain('"feature-flags"')
  })
})
