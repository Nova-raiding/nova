import { describe, expect, it } from 'vitest'
import { assertMcpMethodPolicyCoverage, getMcpMethodPolicy } from './authz.js'
import { resolveCommercialOperation } from './commercial-access.js'
import { COMMERCIAL_OPERATION_REGISTRY, MCP_OPS_CONTROL_METHODS } from './commercial-operation-registry.js'
import { getMcpMethodContract, MCP_METHOD_CONTRACTS, MCP_METHOD_SCHEMAS, MCP_METHODS, validateMcpRequest } from './mcp.js'

const uploadMethod = 'ops.customer-delivery.assets.upload'
const getMethod = 'ops.customer-delivery.assets.get'
const maxContentLength = 69_905_068
const uploadParams = {
  target_workspace_id: 'ws_delivery_upload',
  delivery_id: 'cd_upload_contract',
  purpose: 'contract',
  name: 'contract.pdf',
  mime_type: 'application/pdf',
  content_base64: 'JVBERi0xLjQK',
}
const getParams = {
  target_workspace_id: uploadParams.target_workspace_id,
  delivery_id: uploadParams.delivery_id,
  purpose: 'contract',
  asset_ref: 'asset_contract_1',
}

function validate(method: string, params: Record<string, unknown>) {
  return validateMcpRequest({ jsonrpc: '2.0', id: 'delivery-upload-contract', method, params })
}

describe('customer delivery upload and status MCP contracts', () => {
  it.each([uploadMethod, getMethod])('declares %s exactly once as an enabled platform control operation', method => {
    expect(MCP_METHODS.filter(candidate => candidate === method)).toHaveLength(1)
    expect(MCP_METHOD_CONTRACTS.filter(contract => contract.method === method)).toHaveLength(1)
    expect(MCP_OPS_CONTROL_METHODS.filter(candidate => candidate === method)).toHaveLength(1)
    expect(resolveCommercialOperation(COMMERCIAL_OPERATION_REGISTRY, { surface: 'MCP', operation: method })).toMatchObject({
      outcome: 'REGISTERED',
      policy: { enabled: true, domain: 'OPS_CONTROL', authorization_policy_ref: method, classification: null, rate_action: null },
    })
    expect(getMcpMethodPolicy(method)).toMatchObject({ scope: 'platform', workbench: 'platform', dataClass: 'customer_metadata' })
  })

  it('reuses customer delivery read/write capabilities without inventing upload revision obligations', () => {
    expect(getMcpMethodPolicy(uploadMethod)).toEqual({ ...getMcpMethodPolicy('ops.customer-delivery.create'), method: uploadMethod })
    expect(getMcpMethodPolicy(uploadMethod)).toMatchObject({ capability: 'customer.delivery.update', effect: 'write', audit: 'mutation', obligations: [] })
    expect(getMcpMethodPolicy(getMethod)).toEqual({ ...getMcpMethodPolicy('ops.customer-delivery.get'), method: getMethod })
    expect(getMcpMethodPolicy(getMethod)).toMatchObject({ capability: 'customer.delivery.read', effect: 'read' })
    expect(assertMcpMethodPolicyCoverage()).toMatchObject({ declared: MCP_METHODS.length, registered: MCP_METHODS.length })
  })

  it('publishes explicit bounded upload fields and a lowercase SHA-256 constraint', () => {
    expect(MCP_METHOD_SCHEMAS[uploadMethod]).toMatchObject({
      additionalProperties: false,
      required: ['target_workspace_id', 'delivery_id', 'purpose', 'name', 'mime_type', 'content_base64'],
      properties: {
        target_workspace_id: { type: 'string', minLength: 1, maxLength: 200 },
        delivery_id: { type: 'string', minLength: 1, maxLength: 256 },
        purpose: { type: 'string', enum: ['contract', 'video'] },
        name: { type: 'string', minLength: 1, maxLength: 255 },
        mime_type: { type: 'string', minLength: 1, maxLength: 100 },
        content_base64: { type: 'string', minLength: 1, maxLength: maxContentLength },
        sha256: { type: 'string', minLength: 64, maxLength: 64, pattern: '^[a-f0-9]{64}$' },
      },
    })
    expect(MCP_METHOD_SCHEMAS[uploadMethod].required).not.toContain('sha256')
    expect(getMcpMethodContract(uploadMethod)?.description).toContain('does not assert a clean scan')
  })

  it.each(['contract', 'video'])('accepts %s purpose for both upload and status reads', purpose => {
    expect(validate(uploadMethod, { ...uploadParams, purpose })).toEqual({ valid: true, errors: [] })
    expect(validate(uploadMethod, { ...uploadParams, purpose, sha256: 'a1'.repeat(32) })).toEqual({ valid: true, errors: [] })
    expect(validate(getMethod, { ...getParams, purpose })).toEqual({ valid: true, errors: [] })
  })

  it.each(['target_workspace_id', 'delivery_id', 'purpose', 'name', 'mime_type', 'content_base64'])('requires a nonempty upload %s', field => {
    const missing: Record<string, unknown> = { ...uploadParams }
    delete missing[field]
    expect(validate(uploadMethod, missing).errors).toContain(`params.${field} is required`)
    expect(validate(uploadMethod, { ...uploadParams, [field]: '' }).errors).toContain(`params.${field} is required`)
    expect(validate(uploadMethod, { ...uploadParams, [field]: '   ' }).valid).toBe(false)
  })

  it.each([
    ['target_workspace_id', 200],
    ['delivery_id', 256],
    ['name', 255],
    ['mime_type', 100],
  ] as const)('enforces the exact upload %s length limit', (field, limit) => {
    expect(validate(uploadMethod, { ...uploadParams, [field]: 'a'.repeat(limit) })).toEqual({ valid: true, errors: [] })
    expect(validate(uploadMethod, { ...uploadParams, [field]: 'a'.repeat(limit + 1) }).errors).toContain(`params.${field} must contain at most ${limit} characters`)
  })

  it('accepts the 50 MiB base64 boundary and rejects one extra encoded character', () => {
    const oversized = 'A'.repeat(maxContentLength + 1)
    expect(validate(uploadMethod, { ...uploadParams, content_base64: oversized.slice(0, maxContentLength) })).toEqual({ valid: true, errors: [] })
    expect(validate(uploadMethod, { ...uploadParams, content_base64: oversized }).errors).toContain(`params.content_base64 must contain at most ${maxContentLength} characters`)
  })

  it.each(['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), ` ${'a'.repeat(64)}`])('rejects a malformed optional SHA-256 value %#', sha256 => {
    expect(validate(uploadMethod, { ...uploadParams, sha256 }).valid).toBe(false)
  })

  it('requires scoped, bounded status parameters without permitting an unbound asset lookup', () => {
    expect(MCP_METHOD_SCHEMAS[getMethod]).toMatchObject({
      additionalProperties: false,
      required: ['target_workspace_id', 'delivery_id', 'purpose', 'asset_ref'],
      properties: {
        target_workspace_id: { minLength: 1, maxLength: 200 },
        delivery_id: { minLength: 1, maxLength: 256 },
        purpose: { type: 'string', enum: ['contract', 'video'] },
        asset_ref: { minLength: 1, maxLength: 1000 },
      },
    })
    for (const field of ['target_workspace_id', 'delivery_id', 'purpose', 'asset_ref']) {
      const missing: Record<string, unknown> = { ...getParams }
      delete missing[field]
      expect(validate(getMethod, missing).errors).toContain(`params.${field} is required`)
      expect(validate(getMethod, { ...getParams, [field]: '' }).valid).toBe(false)
    }
    for (const [field, limit] of [['target_workspace_id', 200], ['delivery_id', 256], ['asset_ref', 1000]] as const) {
      expect(validate(getMethod, { ...getParams, [field]: 'a'.repeat(limit) })).toEqual({ valid: true, errors: [] })
      expect(validate(getMethod, { ...getParams, [field]: 'a'.repeat(limit + 1) }).valid).toBe(false)
    }
  })

  it.each([uploadMethod, getMethod])('rejects client-supplied scan verdicts and unsupported purpose for %s', method => {
    const base = method === uploadMethod ? uploadParams : getParams
    expect(validate(method, { ...base, purpose: 'image' }).errors).toContain('params.purpose has an unsupported value')
    for (const field of ['scan_status', 'scan_receipt_id', 'storage_key']) {
      expect(validate(method, { ...base, [field]: 'clean' }).errors).toContain(`params.${field} is not accepted for ${method}`)
    }
  })
})
