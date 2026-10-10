import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  MCP_METHOD_CONTRACTS,
  MCP_METHODS,
} from '../packages/contracts/src/mcp.js'
import {
  MCP_METHOD_POLICIES,
  getMcpMethodPolicy,
} from '../packages/contracts/src/authz.js'
import {
  HTTP_OPERATION_POLICIES,
  assertHttpOperationPolicyCoverage,
} from '../packages/contracts/src/http-authz.js'

const openApiSource = readFileSync(new URL('../apps/api/openapi.yaml', import.meta.url), 'utf8')

function setOf(values: readonly string[], label: string): Set<string> {
  const unique = new Set(values)
  expect(unique.size, `${label} contains duplicate entries`).toBe(values.length)
  return unique
}

function parseOpenApiMcpMethods(source: string): string[] {
  const schemaStart = source.indexOf('\n    McpRequest:')
  expect(schemaStart, 'OpenAPI must define components.schemas.McpRequest').toBeGreaterThanOrEqual(0)
  const nextSchemaMatch = source.slice(schemaStart + 1).match(/\n    [A-Z][A-Za-z0-9]+:\s*$/mu)
  const nextSchema = nextSchemaMatch?.index === undefined ? -1 : schemaStart + 1 + nextSchemaMatch.index
  const block = source.slice(schemaStart, nextSchema < 0 ? undefined : nextSchema)
  const lines = block.split('\n')
  const propertiesIndex = lines.findIndex(line => /^ {6}properties:[ \t]*$/u.test(line))
  expect(propertiesIndex, 'McpRequest.properties schema is required').toBeGreaterThanOrEqual(0)
  const propertiesLines: string[] = []
  for (const line of lines.slice(propertiesIndex + 1)) {
    if (line.trim() && !/^ {8,}/u.test(line)) break
    propertiesLines.push(line)
  }
  const propertiesBlock = propertiesLines.join('\n')
  const methodMarker = propertiesBlock.match(/^[ \t]{8}method:[ \t]*(.*)$/mu)
  expect(methodMarker, 'McpRequest.method schema is required').not.toBeNull()
  const methodSchema = methodMarker![1]!.trim()
  let enumBody = methodSchema.match(/\benum:\s*\[([^\]]*)\]/u)?.[1]
  if (enumBody === undefined) {
    const methodOffset = methodMarker!.index! + methodMarker![0].length
    const afterMethod = propertiesBlock.slice(methodOffset)
    const nextProperty = afterMethod.search(/^[ \t]{8}[A-Za-z][A-Za-z0-9_]*:[ \t]*/mu)
    const methodBlock = nextProperty < 0 ? afterMethod : afterMethod.slice(0, nextProperty)
    const flowEnum = methodBlock.match(/^[ \t]{10}enum:[ \t]*\[([^\]]*)\][ \t]*$/mu)
    if (flowEnum) enumBody = flowEnum[1]
    else {
      const sequenceEnum = methodBlock.match(/^[ \t]{10}enum:[ \t]*\n((?:[ \t]{12}-[ \t]*[^\n]+\n?)+)/mu)
      if (sequenceEnum) enumBody = [...sequenceEnum[1]!.matchAll(/^[ \t]{12}-[ \t]*['"]?([^,'"\]\s]+)['"]?[ \t]*$/gmu)].map(match => match[1]).join(',')
    }
  }
  expect(enumBody, 'McpRequest.method must declare one enum').toBeDefined()
  const values = enumBody!.split(',').map(value => value.trim().replace(/^(['"])(.*)\1$/u, '$2')).filter(Boolean)
  expect(values.length, 'McpRequest.method enum must not be empty').toBeGreaterThan(0)
  expect(new Set(values).size, 'McpRequest.method enum contains duplicates').toBe(values.length)
  expect(values.every(value => /^[A-Za-z0-9._-]+$/u.test(value)), 'McpRequest.method enum contains malformed values').toBe(true)
  return values
}

describe('MCP/HTTP parity contract', () => {
  it('keeps registry, contract, policy, and OpenAPI MCP collections exactly aligned', () => {
    const registry = setOf([...MCP_METHODS], 'MCP_METHODS')
    const contracts = setOf(MCP_METHOD_CONTRACTS.map(contract => contract.method), 'MCP_METHOD_CONTRACTS')
    const policies = setOf(Object.keys(MCP_METHOD_POLICIES), 'MCP_METHOD_POLICIES')
    const openApi = setOf(parseOpenApiMcpMethods(openApiSource), 'OpenAPI McpRequest.method')

    expect(contracts).toEqual(registry)
    expect(policies).toEqual(registry)
    expect(openApi).toEqual(registry)
  })

  it('requires every registered method to have a complete contract and policy', () => {
    for (const method of MCP_METHODS) {
      const contract = MCP_METHOD_CONTRACTS.filter(candidate => candidate.method === method)
      expect(contract, `${method} must have exactly one wire contract`).toHaveLength(1)
      expect(contract[0]!.params.type, `${method} params must be an object`).toBe('object')
      expect(contract[0]!.params.additionalProperties, `${method} params must fail closed`).toBe(false)

      const policy = getMcpMethodPolicy(method)
      expect(policy, `${method} must have an authorization policy`).toBeDefined()
      expect(policy?.method).toBe(method)
      expect(policy?.capability).toBeTruthy()
      expect(policy?.workbench).toMatch(/^(platform|workspace)$/u)
      expect(policy?.scope).toMatch(/^(self|workspace|brand|account|platform)$/u)
    }
  })

  it('keeps every identity HTTP operation bound to the same registered MCP policy', () => {
    expect(assertHttpOperationPolicyCoverage().registered).toBe(HTTP_OPERATION_POLICIES.length)
    const identityReferences = HTTP_OPERATION_POLICIES
      .filter(operation => operation.authentication === 'identity' && !operation.identityOnly)
      .map(operation => operation.mcpMethod!)
    const registry = new Set<string>(MCP_METHODS)
    const references = new Set(identityReferences)

    for (const method of references) {
      expect(registry.has(method), `HTTP identity operation references unknown MCP method: ${method}`).toBe(true)
      expect(Object.prototype.hasOwnProperty.call(MCP_METHOD_POLICIES, method), `HTTP identity operation lacks policy: ${method}`).toBe(true)
    }
  })

  it('fails closed when a parity source is malformed instead of silently accepting a partial set', () => {
    const invalidMethod = openApiSource.replace("'onboarding.status',", "'invalid method!',")
    expect(invalidMethod).not.toBe(openApiSource)
    expect(() => parseOpenApiMcpMethods(invalidMethod)).toThrow('McpRequest.method enum contains malformed values')
    const requestSchemaStart = openApiSource.indexOf('\n    McpRequest:')
    const methodLineStart = openApiSource.indexOf('\n        method:', requestSchemaStart) + 1
    const methodLineEnd = openApiSource.indexOf('\n', methodLineStart) + 1
    const missingMethod = openApiSource.slice(0, methodLineStart) + openApiSource.slice(methodLineEnd)
    expect(missingMethod).not.toBe(openApiSource)
    expect(() => parseOpenApiMcpMethods(missingMethod)).toThrow('McpRequest.method schema is required')
  })

  it('parses a valid block-style method enum as well as the inline OpenAPI form', () => {
    const blockStyle = `
    McpRequest:
      type: object
      properties:
        method:
          type: string
          enum:
            - onboarding.status
            - merchant.start
    NextSchema:
      type: object
`
    expect(parseOpenApiMcpMethods(blockStyle)).toEqual(['onboarding.status', 'merchant.start'])
    expect(parseOpenApiMcpMethods(openApiSource)).toContain('merchant.start')
  })
})
