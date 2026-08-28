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

  it('covers the six operations domains with routed page components', () => {
    const source = readFileSync(new URL('../apps/ops-console/src/navigation/opsNavigation.ts', import.meta.url), 'utf8')
    for (const domain of ['overview', 'users', 'tasks', 'stores', 'models', 'finance']) expect(source).toContain(`"${domain}"`)
  })
})
