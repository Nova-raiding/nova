import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MCP_METHODS } from '../packages/contracts/src/mcp.js'
import { MCP_METHOD_POLICIES } from '../packages/contracts/src/authz.js'
import { HTTP_OPERATION_POLICIES, assertHttpOperationPolicyCoverage } from '../packages/contracts/src/http-authz.js'

const workerExecutionAuthorization = readFileSync(new URL('../packages/workers/src/execution-authorization.ts', import.meta.url), 'utf8')
const workerMain = readFileSync(new URL('../apps/worker/src/main.ts', import.meta.url), 'utf8')

const validScopes = new Set(['workspace', 'brand', 'account', 'self', 'platform'])
const validObligations = new Set(['reason', 'revision', 'idempotency', 'confirmation', 'mfa', 'approval', 'two_person', 'jit_grant'])

function authorizationReleaseReport() {
  const methods = [...MCP_METHODS]
  const policies = Object.values(MCP_METHOD_POLICIES)
  const identityRoutes = HTTP_OPERATION_POLICIES.filter(policy => policy.authentication === 'identity')
  const methodsWithPolicy = methods.filter(method => Object.prototype.hasOwnProperty.call(MCP_METHOD_POLICIES, method))
  const identityRoutesWithPolicy = identityRoutes.filter(policy => policy.mcpMethod !== undefined && Object.prototype.hasOwnProperty.call(MCP_METHOD_POLICIES, policy.mcpMethod))
  const scopedPolicies = policies.filter(policy => validScopes.has(policy.scope))
  const obligationPolicies = policies.filter(policy => policy.obligations.every(obligation => validObligations.has(obligation)))

  return {
    mcp_total: methods.length,
    policy_total: policies.length,
    mcp_policy_coverage: methods.length === 0 ? 1 : methodsWithPolicy.length / methods.length,
    http_identity_total: identityRoutes.length,
    http_identity_policy_coverage: identityRoutes.length === 0 ? 1 : identityRoutesWithPolicy.length / identityRoutes.length,
    scoped_policy_total: scopedPolicies.length,
    scope_coverage: policies.length === 0 ? 1 : scopedPolicies.length / policies.length,
    obligation_policy_total: obligationPolicies.length,
    obligation_coverage: policies.length === 0 ? 1 : obligationPolicies.length / policies.length,
    worker_snapshot_contract: [
      'decision_id', 'scope_hash', 'policy_version', 'grant_ids', 'resource_revision',
    ].every(field => workerExecutionAuthorization.includes(field) || workerMain.includes(field)),
  } as const
}

describe('authorization release dynamic gate', () => {
  it('computes live registry denominators and requires complete local coverage', () => {
    const report = authorizationReleaseReport()

    expect(assertHttpOperationPolicyCoverage()).toMatchObject({ registered: report.http_identity_total + HTTP_OPERATION_POLICIES.filter(policy => policy.authentication !== 'identity').length })
    expect(report.mcp_total).toBeGreaterThan(0)
    expect(report.policy_total).toBe(report.mcp_total)
    expect(report.mcp_policy_coverage).toBe(1)
    expect(report.http_identity_policy_coverage).toBe(1)
    expect(report.scope_coverage).toBe(1)
    expect(report.obligation_coverage).toBe(1)
    expect(report.worker_snapshot_contract).toBe(true)
  })

  it('fails closed when a live registry item has no policy or invalid obligation', () => {
    const methods = [...MCP_METHODS]
    const policies = Object.values(MCP_METHOD_POLICIES)
    const missing = methods.filter(method => !Object.prototype.hasOwnProperty.call(MCP_METHOD_POLICIES, method))
    const invalidObligations = policies.flatMap(policy => policy.obligations.filter(obligation => !validObligations.has(obligation)).map(obligation => `${policy.method}:${obligation}`))

    expect(missing).toEqual([])
    expect(invalidObligations).toEqual([])
  })
})
