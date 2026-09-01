import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { MCP_METHODS } from './mcp.js'
import { getMcpMethodPolicy } from './authz.js'
import { HTTP_OPERATION_POLICIES, assertHttpOperationPolicyCoverage, getHttpOperationPolicy } from './http-authz.js'

describe('HTTP authorization policy registry', () => {
  it('is unique and every identity operation references a registered MCP policy', () => {
    expect(assertHttpOperationPolicyCoverage()).toEqual({ registered: HTTP_OPERATION_POLICIES.length, identity: HTTP_OPERATION_POLICIES.filter(policy => policy.authentication === 'identity').length })
    const methods = new Set<string>(MCP_METHODS)
    for (const policy of HTTP_OPERATION_POLICIES) {
      if (policy.authentication === 'identity') {
        expect(methods.has(policy.mcpMethod!), `${policy.operation} references an unknown MCP method`).toBe(true)
        expect(getMcpMethodPolicy(policy.mcpMethod!)).toBeDefined()
      }
    }
  })

  it('keeps HTTP identity write semantics aligned with the referenced MCP policy', () => {
    const readMethods = new Set(['GET'])
    const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
    // This endpoint computes a review decision/read model from the current
    // content version; its MCP operation is intentionally customer-content
    // update because the review computation is an authorization-sensitive
    // mutation boundary, even though the HTTP transport is GET.
    const readTransportWriteOperations = new Set([
      'http:GET:/v1/content-versions/{contentVersionId}/review',
      'http:GET:/v1/content-versions/{contentVersionId}/export',
    ])

    for (const policy of HTTP_OPERATION_POLICIES) {
      if (policy.authentication !== 'identity') continue
      const mcpPolicy = getMcpMethodPolicy(policy.mcpMethod!)!
      const expectedEffect = readMethods.has(policy.method) ? 'read' : 'write'
      if (readTransportWriteOperations.has(policy.operation)) {
        expect(mcpPolicy.effect, `${policy.operation} must preserve its documented review boundary`).toBe('write')
      } else {
        expect(mcpPolicy.effect, `${policy.operation} must preserve MCP effect semantics`).toBe(expectedEffect)
      }
      expect(policy.operation).toBe(`http:${policy.method}:${policy.pathTemplate}`)
      expect(readMethods.has(policy.method) || writeMethods.has(policy.method)).toBe(true)
    }
  })

  it('matches exact templates without accepting sibling or descendant paths', () => {
    expect(getHttpOperationPolicy('POST', '/v1/tasks/task-1/approve')).toMatchObject({ mcpMethod: 'content.approve', authentication: 'identity' })
    expect(getHttpOperationPolicy('post', '/v1/tasks/task-1/approve')).toMatchObject({ mcpMethod: 'content.approve', authentication: 'identity' })
    expect(getHttpOperationPolicy('GET', '/v1/oauth/callback/jd')).toMatchObject({ authentication: 'oauth_callback' })
    expect(getHttpOperationPolicy('GET', '/v1/tasks/task-1/approve')).toBeUndefined()
    expect(getHttpOperationPolicy('POST', '/v1/tasks/task-1/approve/extra')).toBeUndefined()
  })

  it('fails closed for encoded route separators and malformed paths', () => {
    expect(getHttpOperationPolicy('GET', '/v1/tasks/task%2F1')).toBeUndefined()
    expect(getHttpOperationPolicy('GET', '/v1/tasks/task%5C1')).toBeUndefined()
    expect(getHttpOperationPolicy('GET', '/v1/tasks/task%ZZ')).toBeUndefined()
    expect(getHttpOperationPolicy('GET', '/v1/tasks/task\u00001')).toBeUndefined()
    expect(getHttpOperationPolicy('GET', 'v1/tasks/task-1')).toBeUndefined()
  })

  it('covers every documented OpenAPI operation exactly once while retaining internal runtime policies', () => {
    const source = readFileSync(new URL('../../../apps/api/openapi.yaml', import.meta.url), 'utf8')
    const operations: string[] = []
    let path = ''
    for (const line of source.split('\n')) {
      const pathMatch = /^  (\/[^:]+):\s*$/u.exec(line)
      if (pathMatch) { path = pathMatch[1]!; continue }
      const methodMatch = /^    (get|post|put|patch|delete):\s*$/u.exec(line)
      if (path && methodMatch) operations.push(`http:${methodMatch[1]!.toUpperCase()}:${path}`)
    }
    const registered = new Set<string>(HTTP_OPERATION_POLICIES.map(policy => policy.operation))
    expect(operations.filter(operation => !registered.has(operation))).toEqual([])
    expect(new Set(operations).size).toBe(operations.length)
  })
})
