import { describe, expect, it } from 'vitest'
import {
  COMMERCIAL_OPERATION_REGISTRY,
  getHttpOperationPolicy,
  getMcpMethodPolicy,
  resolveCommercialOperation,
} from './index.js'

describe('content export HTTP/MCP parity', () => {
  it('binds the HTTP export route to the exact MCP authorization policy', () => {
    const http = getHttpOperationPolicy('GET', '/v1/content-versions/cv_123/export')
    expect(http).toMatchObject({
      method: 'GET',
      pathTemplate: '/v1/content-versions/{contentVersionId}/export',
      authentication: 'identity',
      mcpMethod: 'content.export',
    })

    const mcp = getMcpMethodPolicy('content.export')
    expect(mcp).toMatchObject({
      capability: 'customer.publish.execute',
      scope: 'workspace',
      workbench: 'workspace',
      effect: 'write',
    })

    const httpResolution = resolveCommercialOperation(COMMERCIAL_OPERATION_REGISTRY, {
      surface: 'HTTP',
      operation: 'http:GET:/v1/content-versions/{contentVersionId}/export',
    })
    const mcpResolution = resolveCommercialOperation(COMMERCIAL_OPERATION_REGISTRY, {
      surface: 'MCP',
      operation: 'content.export',
    })
    expect(httpResolution).toMatchObject({
      outcome: 'REGISTERED',
      policy: {
        domain: 'COMMERCIAL',
        enabled: true,
        classification: 'POINT_REQUIRED_NO_CHARGE',
        authorization_policy_ref: 'content.export',
      },
    })
    expect(mcpResolution).toMatchObject({
      outcome: 'REGISTERED',
      policy: {
        domain: 'COMMERCIAL',
        enabled: true,
        classification: 'POINT_REQUIRED_NO_CHARGE',
        authorization_policy_ref: 'content.export',
      },
    })
  })

  it('rejects ambiguous or encoded resource paths before authorization lookup', () => {
    expect(getHttpOperationPolicy('GET', '/v1/content-versions/cv%2Fother/export')).toBeUndefined()
    expect(getHttpOperationPolicy('GET', '/v1/content-versions/cv_123%00/export')).toBeUndefined()
    expect(getHttpOperationPolicy('POST', '/v1/content-versions/cv_123/export')).toBeUndefined()
  })
})
