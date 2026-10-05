import { describe, expect, it } from 'vitest'
import { getHttpOperationPolicy } from './http-authz.js'
import { COMMERCIAL_OPERATION_REGISTRY, HTTP_CUSTOMER_SUPPORT_RECOVERY_OPERATIONS, HTTP_MACHINE_INFRASTRUCTURE_OPERATIONS, WORKER_RUNTIME_OPERATIONS } from './commercial-operation-registry.js'
import { requiredCommercialFeatures } from './commercial-feature-definitions.js'
import { resolveCommercialOperation } from './commercial-access.js'

describe('commercial worker execution registries', () => {
  it('registers the exact runtime protocol probe as infrastructure rather than commercial success', () => {
    const path = '/internal/commercial-runtime-attestation'
    const operation = `http:GET:${path}`
    const policy = getHttpOperationPolicy('GET', path)!
    expect(policy).toMatchObject({ authentication: 'infrastructure', operation })
    expect(policy.mcpMethod).toBeUndefined()
    expect(HTTP_MACHINE_INFRASTRUCTURE_OPERATIONS).toContain(operation)
    expect(resolveCommercialOperation(COMMERCIAL_OPERATION_REGISTRY, { surface: 'HTTP', operation })).toMatchObject({ outcome: 'REGISTERED', policy: { domain: 'MACHINE_INFRASTRUCTURE', classification: null, rate_action: null } })
    expect(getHttpOperationPolicy('POST', path)).toBeUndefined()
    expect(getHttpOperationPolicy('GET', `${path}/extra`)).toBeUndefined()
  })

  it('keeps notification fanout on the signed worker infrastructure boundary', () => {
    const operation = 'http:POST:/v1/internal/commercial/notifications/tick'
    expect(getHttpOperationPolicy('POST', '/v1/internal/commercial/notifications/tick')).toMatchObject({ authentication: 'worker', operation })
    expect(getHttpOperationPolicy('GET', '/v1/internal/commercial/notifications/tick')).toBeUndefined()
    expect(getHttpOperationPolicy('POST', '/v1/internal/commercial/notifications/tick/extra')).toBeUndefined()
    expect(HTTP_MACHINE_INFRASTRUCTURE_OPERATIONS).toContain(operation)
    expect(resolveCommercialOperation(COMMERCIAL_OPERATION_REGISTRY, { surface: 'HTTP', operation })).toMatchObject({ outcome: 'REGISTERED', policy: { domain: 'MACHINE_INFRASTRUCTURE', enabled: true, classification: null } })
  })

  it('keeps pre-order merchant support as exact authenticated recovery without Ops impersonation', () => {
    for (const [verb, path] of [['POST', '/v1/support/requests'], ['GET', '/v1/support/requests/ticket-1']]) {
      const httpPolicy = getHttpOperationPolicy(verb!, path!)!
      expect(httpPolicy).toMatchObject({ authentication: 'identity', identityOnly: true })
      expect(httpPolicy.mcpMethod).toBeUndefined()
      expect(HTTP_CUSTOMER_SUPPORT_RECOVERY_OPERATIONS).toContain(httpPolicy.operation)
      expect(resolveCommercialOperation(COMMERCIAL_OPERATION_REGISTRY, { surface: 'HTTP', operation: httpPolicy.operation })).toMatchObject({ outcome: 'REGISTERED', policy: { domain: 'COMMERCIAL', classification: 'RECOVERY_CONTROL', rate_action: null, authorization_policy_ref: null } })
    }
    expect(getHttpOperationPolicy('POST', '/v1/support/requests/ticket-1')).toBeUndefined()
    expect(getHttpOperationPolicy('GET', '/v1/support/requests/ticket-1/extra')).toBeUndefined()
  })

  it.each([
    ['automation.tick.execute', 'feature.automation'],
    ['knowledge.embedding.execute', 'feature.knowledge'],
  ])('requires actual feature permission for %s without inventing a second charge', (operation, feature) => {
    expect(WORKER_RUNTIME_OPERATIONS).toContain(operation)
    const resolution = resolveCommercialOperation(COMMERCIAL_OPERATION_REGISTRY, { surface: 'WORKER', operation })
    expect(resolution).toMatchObject({ outcome: 'REGISTERED', policy: { domain: 'COMMERCIAL', enabled: true, classification: 'POINT_REQUIRED_NO_CHARGE', rate_action: null } })
    expect(requiredCommercialFeatures(resolution.policy!)).toEqual([feature])
    expect(resolveCommercialOperation(COMMERCIAL_OPERATION_REGISTRY, { surface: 'WORKER', operation: `${operation}.extra` }).outcome).toBe('DENY_UNCLASSIFIED')
  })
})
