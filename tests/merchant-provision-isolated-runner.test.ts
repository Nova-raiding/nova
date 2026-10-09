import { describe, expect, it } from 'vitest'
import { configureMerchantProvisionFixture } from '../scripts/verify-ops-merchant-provision-isolated.js'
import type { OpsE2eContext } from '../scripts/run-ops-password-e2e.js'

function context(workspaceId = 'ws_ops_fixture_11111111111141118111111111111111'): OpsE2eContext {
  const runId = '11111111-1111-4111-8111-111111111111'
  return {
    fixture: { runId, workspaceId } as OpsE2eContext['fixture'],
    baseUrl: 'http://127.0.0.1:45101/',
    username: 'fixture-operator',
    password: 'fixture-password',
    evidenceDir: '/tmp/isolated-run-11111111',
    environment: {
      MERCHANT_STUDIO_URL: 'http://127.0.0.1:45102/',
      OPS_PROVISION_RUN: 'false',
      OPS_PROVISION_QA_WORKSPACE_ID: 'ws_external_must_be_overwritten',
      OPS_PROVISION_QA_WORKSPACE_CONFIRMED: 'ws_external_must_be_overwritten',
      OPS_PROVISION_OUTPUT_DIR: '/tmp/external-path-must-be-overwritten',
    },
  } as OpsE2eContext
}

describe('isolated merchant provisioning runner', () => {
  it('injects only the run-owned workspace and evidence directory into the browser environment', async () => {
    const candidate = context()
    await configureMerchantProvisionFixture(candidate)
    expect(candidate.environment).toMatchObject({
      OPS_PROVISION_RUN: 'true',
      OPS_PROVISION_QA_WORKSPACE_ID: candidate.fixture.workspaceId,
      OPS_PROVISION_QA_WORKSPACE_CONFIRMED: candidate.fixture.workspaceId,
      OPS_PROVISION_OUTPUT_DIR: '/tmp/isolated-run-11111111/merchant-provision',
    })
    expect(candidate.environment.OPS_PROVISION_QA_WORKSPACE_ID).not.toBe('ws_external_must_be_overwritten')
  })

  it('refuses a workspace that is not the current disposable fixture identity', async () => {
    await expect(configureMerchantProvisionFixture(context('ws_customer_workspace')))
      .rejects.toThrow('OPS_E2E_MERCHANT_PROVISION_FIXTURE_WORKSPACE_MISMATCH')
  })

  it.each(['https://yxsona.com/', 'http://10.0.0.2:45101/', 'http://127.0.0.1/'])('refuses nonlocal or unbounded Ops origins: %s', async baseUrl => {
    const candidate = context()
    candidate.baseUrl = baseUrl
    await expect(configureMerchantProvisionFixture(candidate)).rejects.toThrow('OPS_E2E_MERCHANT_PROVISION_OPS_LOOPBACK_REQUIRED')
  })

  it('requires the merchant and Ops pages to use separate loopback gateways', async () => {
    const candidate = context()
    candidate.environment.MERCHANT_STUDIO_URL = candidate.baseUrl
    await expect(configureMerchantProvisionFixture(candidate))
      .rejects.toThrow('OPS_E2E_MERCHANT_PROVISION_ORIGINS_MUST_DIFFER')
  })
})
