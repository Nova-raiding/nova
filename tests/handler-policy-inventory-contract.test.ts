import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MCP_METHOD_POLICIES } from '../packages/contracts/src/authz.js'
import { MCP_METHOD_CONTRACTS, MCP_METHODS } from '../packages/contracts/src/mcp.js'

const serverSource = readFileSync(new URL('../apps/api/src/server.ts', import.meta.url), 'utf8')

type Inventory = {
  readonly methods: readonly string[]
  readonly cases: readonly string[]
  readonly guards: readonly string[]
}

const routeStartMarker = 'async function routeMcp('
const routeEndMarker = 'export function imageGenerationReconciliationIdempotencyKey'

function routeMcpSource(source: string): string {
  const start = source.indexOf(routeStartMarker)
  const end = source.indexOf(routeEndMarker, start + routeStartMarker.length)
  if (start < 0 || end < 0 || end <= start) throw new Error('HANDLER_INVENTORY_ROUTE_BOUNDARY_INVALID')
  return source.slice(start, end)
}

function unique(values: readonly string[], label: string): string[] {
  const duplicate = values.find((value, index) => values.indexOf(value) !== index)
  if (duplicate) throw new Error(`HANDLER_POLICY_INVENTORY_DUPLICATE:${label}:${duplicate}`)
  return [...new Set(values)]
}

function parseDispatchInventory(source: string): Inventory {
  const route = routeMcpSource(source)
  const cases = [...route.matchAll(/\bcase\s+(['"])([^'"\n]+)\1\s*:/gu)].map(match => match[2]!)
  const guards = [...route.matchAll(/\bmethod\s*===\s*(['"])([^'"\n]+)\1/gu)].map(match => match[2]!)
  const nonMethodStringLiterals = new Set(['string'])
  const unsupportedGuards = guards.filter(method => nonMethodStringLiterals.has(method))
  const dispatchGuards = guards.filter(method => !nonMethodStringLiterals.has(method))
  if (unsupportedGuards.length !== 1) throw new Error('HANDLER_INVENTORY_UNEXPECTED_NON_METHOD_LITERAL')
  if (cases.length === 0) throw new Error('HANDLER_INVENTORY_EMPTY_DISPATCH')

  const caseMethods = unique(cases, 'case')
  const guardMethods = [...new Set(dispatchGuards)]
  const methods = [...new Set([...caseMethods, ...guardMethods])]
  if (methods.some(method => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(method))) {
    throw new Error('HANDLER_INVENTORY_MALFORMED_METHOD')
  }
  if (methods.some(method => !MCP_METHODS.includes(method as typeof MCP_METHODS[number]))) {
    throw new Error(`HANDLER_INVENTORY_UNKNOWN_METHOD:${methods.find(method => !MCP_METHODS.includes(method as typeof MCP_METHODS[number]))}`)
  }
  return { methods, cases: caseMethods, guards: guardMethods }
}

function setOf(values: readonly string[], label: string): Set<string> {
  const result = new Set(values)
  expect(result.size, `${label} contains duplicate entries`).toBe(values.length)
  return result
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort()
}

describe('Ops RBAC handler/policy inventory contract', () => {
  it('derives the dispatch inventory and requires exact registry, contract, and policy parity', () => {
    const inventory = parseDispatchInventory(serverSource)
    const handlers = setOf(inventory.methods, 'routeMcp dispatch inventory')
    const registry = setOf(MCP_METHODS, 'MCP_METHODS')
    const contracts = setOf(MCP_METHOD_CONTRACTS.map(contract => contract.method), 'MCP_METHOD_CONTRACTS')
    const policies = setOf(Object.keys(MCP_METHOD_POLICIES), 'MCP_METHOD_POLICIES')

    expect(sorted(handlers)).toEqual(sorted(registry))
    expect(sorted(handlers)).toEqual(sorted(contracts))
    expect(sorted(handlers)).toEqual(sorted(policies))
  })

  it('requires every dispatched method to resolve to one closed contract and policy', () => {
    const inventory = parseDispatchInventory(serverSource)
    for (const method of inventory.methods) {
      const contracts = MCP_METHOD_CONTRACTS.filter(contract => contract.method === method)
      expect(contracts, `${method} must have exactly one contract`).toHaveLength(1)
      expect(contracts[0]!.params.type, `${method} params must be an object`).toBe('object')
      expect(contracts[0]!.params.additionalProperties, `${method} params must fail closed`).toBe(false)

      const policy = MCP_METHOD_POLICIES[method as keyof typeof MCP_METHOD_POLICIES]
      expect(policy, `${method} must have exactly one policy`).toBeDefined()
      expect(policy?.method).toBe(method)
      expect(policy?.capability).toBeTruthy()
      expect(policy?.workbench).toMatch(/^(platform|workspace)$/u)
      expect(policy?.scope).toMatch(/^(self|workspace|brand|account|platform)$/u)
    }
  })

  it('fails closed when the dispatch inventory cannot be parsed or contains duplicate handlers', () => {
    expect(() => parseDispatchInventory(serverSource.replace(routeStartMarker, 'async function routeMcpMissing('))).toThrow(/ROUTE_BOUNDARY_INVALID/u)
    expect(() => parseDispatchInventory(serverSource.replace("case 'merchant.first_value':", "case 'merchant.first_value':\n    case 'merchant.first_value':"))).toThrow(/DUPLICATE:case:merchant\.first_value/u)
    expect(() => parseDispatchInventory(serverSource.replace("case 'merchant.first_value':", "case 'not-registered.method':"))).toThrow(/toEqual|HANDLER/u)
  })
})
