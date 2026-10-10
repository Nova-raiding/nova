import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HTTP_OPERATION_POLICIES } from '../packages/contracts/src/http-authz.js'

const source = readFileSync(new URL('../apps/api/openapi.yaml', import.meta.url), 'utf8')

function operation(path: string, method: string): string {
  const pathStart = source.indexOf(`  ${path}:\n`)
  expect(pathStart, `OpenAPI path missing: ${path}`).toBeGreaterThanOrEqual(0)
  const nextPathOffset = source.slice(pathStart + 1).search(/^  \/[^\n]*:\s*$/mu)
  const pathBlock = source.slice(pathStart, nextPathOffset < 0 ? undefined : pathStart + 1 + nextPathOffset)
  const methodStart = pathBlock.indexOf(`    ${method}:\n`)
  expect(methodStart, `OpenAPI operation missing: ${method.toUpperCase()} ${path}`).toBeGreaterThanOrEqual(0)
  const remaining = pathBlock.slice(methodStart + 1)
  const nextMethod = remaining.search(/^    (?:get|post|put|patch|delete):\s*$/mu)
  return pathBlock.slice(methodStart, nextMethod < 0 ? undefined : methodStart + 1 + nextMethod)
}

const operations = [
  ['POST', '/v1/ops/merchant-accounts'],
  ['GET', '/v1/public/assets/{assetId}/display'],
  ['GET', '/v1/brand-scopes'],
  ['PUT', '/v1/brand-scopes'],
  ['POST', '/v1/brand-scopes/series'],
  ['PUT', '/v1/brand-scopes/assets/{assetId}/assignment'],
  ['PUT', '/v1/assets/{assetId}/rights'],
  ['POST', '/v1/assets/{assetId}/facts'],
  ['POST', '/v1/platform-accounts/{platform}/manual-record'],
] as const

describe('OpenAPI parity for identity HTTP routes', () => {
  it('documents each selected registered operation with method, params, body and error responses', () => {
    for (const [method, path] of operations) {
      const policy = HTTP_OPERATION_POLICIES.find(candidate => candidate.method === method && candidate.pathTemplate === path)
      expect(policy, `${method} ${path} must be present in the authorization registry`).toBeDefined()
      expect(policy?.authentication).toBe(method === 'GET' && path.includes('/public/assets/') ? 'signed_asset' : 'identity')

      const text = operation(path, method.toLowerCase())
      expect(text).toContain('responses:')
      if (path.includes('{') || path.startsWith('/v1/brand-scopes')) expect(text).toContain('parameters:')
      if (method !== 'GET') expect(text).toContain('requestBody:')
      expect(text.includes("'200':") || text.includes("'201':")).toBe(true)
      if (policy?.authentication === 'identity') {
        expect(text).toContain("'401':")
        expect(text).toContain("'403':")
      }
    }
  })

  it('documents the merchant invitation and credential-free manual registration input boundaries', () => {
    const invitation = operation('/v1/ops/merchant-accounts', 'post')
    expect(invitation).toContain('required: [login, enterprise_name, contact_name, workspace_ids, reason, idempotency_key]')
    expect(invitation).toContain('workspace_ids: { type: array, maxItems: 1')
    expect(invitation).toContain('additionalProperties: false')
    expect(invitation).toContain("'201':")

    const manualRecord = operation('/v1/platform-accounts/{platform}/manual-record', 'post')
    expect(manualRecord).toContain("$ref: '#/components/schemas/Platform'")
    expect(manualRecord).toContain('required: [account_id, store_name]')
    expect(manualRecord).toContain('maxLength: 256')
    expect(manualRecord).toContain('maxLength: 40')
    expect(manualRecord).toContain("'201':")
  })

  it('documents scoped-brand revision, tenant-bound settings, and assignment inputs', () => {
    const settings = operation('/v1/brand-scopes', 'put')
    expect(settings).toContain('required: [settings, expected_revision]')
    expect(settings).toContain("$ref: '#/components/schemas/ScopedBrandSettings'")
    expect(settings).toContain('expected_revision: { type: integer, minimum: 0')
    expect(source).toContain('    ScopedBrandSettings:')
    expect(source).toContain('    ScopedBrandEntry:')

    const assignment = operation('/v1/brand-scopes/assets/{assetId}/assignment', 'put')
    expect(assignment).toContain('required: [account_id, expected_revision]')
    expect(assignment).toContain('series_id: { type: string, nullable: true')
    expect(assignment).toContain("'410':")
  })

  it('documents rights/facts validation and signed image query authentication', () => {
    const rights = operation('/v1/assets/{assetId}/rights', 'put')
    expect(rights).toContain('required: [rights_status]')
    expect(rights).toContain('enum: [approved, rejected, pending]')
    expect(rights).toContain('applicable_platforms: { type: array')
    expect(rights).toContain('ai_modification_allowed: { type: boolean }')

    const facts = operation('/v1/assets/{assetId}/facts', 'post')
    expect(facts).toContain('required: [facts, reason]')
    expect(facts).toContain('facts: { type: object, minProperties: 1')

    const display = operation('/v1/public/assets/{assetId}/display', 'get')
    expect(display).toContain('security: []')
    for (const name of ['workspace_id', 'expires', 'sha256', 'signature']) {
      expect(display).toContain(`name: ${name}, in: query, required: true`)
    }
    expect(display).toContain('name: v, in: query, required: false')
    expect(display).toContain('name: kid, in: query, required: false')
    expect(display).toContain('image/png:')
    expect(display).toContain('format: binary')
    expect(display).toContain("'415':")
  })
})
