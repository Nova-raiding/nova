import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MCP_METHODS } from '../packages/contracts/src/mcp.js'

function parseMcpRequestSchema(source: string) {
  const lines = source.split('\n')
  const start = lines.findIndex(line => line === '    McpRequest:')
  expect(start).toBeGreaterThanOrEqual(0)
  const endOffset = lines.slice(start + 1).findIndex(line => /^    \S/u.test(line))
  const block = lines.slice(start + 1, endOffset < 0 ? undefined : start + 1 + endOffset)
  const propertiesIndex = block.findIndex(line => line === '      properties:')
  expect(propertiesIndex).toBeGreaterThanOrEqual(0)
  const propertyLines = block.slice(propertiesIndex + 1)
  const properties = new Map<string, string[]>()
  for (let index = 0; index < propertyLines.length;) {
    const property = propertyLines[index]!.match(/^        ([\w]+):(?:\s.*)?$/u)?.[1]
    if (!property) { index += 1; continue }
    const nested: string[] = []
    index += 1
    while (index < propertyLines.length && !/^        [\w]+:/u.test(propertyLines[index]!)) {
      nested.push(propertyLines[index]!)
      index += 1
    }
    properties.set(property, nested)
  }
  const methodEnumLine = properties.get('method')?.find(line => /^          enum: \[/u.test(line))
  const methodEnum = methodEnumLine?.slice(methodEnumLine.indexOf('[') + 1, methodEnumLine.lastIndexOf(']')).split(',').map(item => item.trim()) ?? []
  return { block, properties, methodEnum }
}

describe('OpenAPI security contract', () => {
  it('documents the implemented security response/status surface and method allowlist', () => {
    const source = readFileSync(resolve(process.cwd(), 'apps/api/openapi.yaml'), 'utf8')
    for (const path of ['/v1/oauth/callback/{platform}:', '/v1/rules/audit:', '/v1/rules/{packId}/versions:', '/v1/rules/{packId}/versions/{version}/status:', '/v1/publish-jobs:', '/v1/publish-jobs/{jobId}:', '/mcp:']) expect(source).toContain(path)
    expect(source).toContain("REQUEST_BODY_TOO_LARGE")
    expect(source).toContain("'429': { $ref: '#/components/responses/ErrorEnvelope' }")
    expect(source).toContain('name: X-Workspace-Id')
    expect(source).toContain('name: Idempotency-Key')
    expect(source).toContain('publish.confirm')
    expect(source).toContain('X-Rule-Approval-Token')
    expect(source).toContain('rules_admin')
    expect(source).not.toContain('admin.raw_sql')
    const mcpRequest = parseMcpRequestSchema(source)
    expect(mcpRequest.properties.has('enum'), 'enum must be nested under properties.method').toBe(false)
    expect(mcpRequest.methodEnum).toEqual([...MCP_METHODS])
  })
})
