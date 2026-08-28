import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MCP_METHODS } from '../packages/contracts/src/mcp.js'

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
    const enumLine = source.match(/enum: \[(merchant\.start,[^\n]+)\]/)?.[1]
    expect(enumLine).toBeTruthy()
    const documented = enumLine!.split(',').map(item => item.trim())
    expect(documented).toEqual(expect.arrayContaining([...MCP_METHODS]))
  })
})
