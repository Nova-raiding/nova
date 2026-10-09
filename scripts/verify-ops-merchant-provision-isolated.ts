import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runOpsE2e, type OpsE2eContext } from './run-ops-password-e2e.js'

export const OPS_MERCHANT_PROVISION_SPEC = 'dogfood/chatgpt-all-functions/ops-merchant-provision-live.spec.js'

/** Bind the browser provisioning probe to the workspace created in this exact disposable fixture. */
export async function configureMerchantProvisionFixture({ fixture, baseUrl, evidenceDir, environment }: OpsE2eContext): Promise<void> {
  const expectedWorkspaceId = `ws_ops_fixture_${fixture.runId.replaceAll('-', '')}`
  if (!/^[a-f0-9-]{36}$/u.test(fixture.runId) || fixture.workspaceId !== expectedWorkspaceId) {
    throw new Error('OPS_E2E_MERCHANT_PROVISION_FIXTURE_WORKSPACE_MISMATCH')
  }
  const assertLoopback = (raw: string | undefined, name: string): URL => {
    let url: URL
    try { url = new URL(raw ?? '') } catch { throw new Error(`OPS_E2E_MERCHANT_PROVISION_${name}_LOOPBACK_REQUIRED`) }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
      throw new Error(`OPS_E2E_MERCHANT_PROVISION_${name}_LOOPBACK_REQUIRED`)
    }
    return url
  }
  const ops = assertLoopback(baseUrl, 'OPS')
  const merchant = assertLoopback(environment.MERCHANT_STUDIO_URL, 'MERCHANT')
  if (ops.origin === merchant.origin) throw new Error('OPS_E2E_MERCHANT_PROVISION_ORIGINS_MUST_DIFFER')

  environment.OPS_PROVISION_RUN = 'true'
  environment.OPS_PROVISION_QA_WORKSPACE_ID = fixture.workspaceId
  environment.OPS_PROVISION_QA_WORKSPACE_CONFIRMED = fixture.workspaceId
  environment.OPS_PROVISION_OUTPUT_DIR = resolve(evidenceDir, 'merchant-provision')
}

const inheritedForLocalTools = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'LANG', 'LC_ALL', 'CI', 'NO_COLOR'] as const
const source: NodeJS.ProcessEnv = Object.fromEntries(inheritedForLocalTools
  .filter(key => process.env[key] !== undefined)
  .map(key => [key, process.env[key]]))
source.OPS_E2E_MERCHANT_UI = 'true'
source.OPS_E2E_MERCHANT_PROVISION = 'true'

async function main(): Promise<void> {
  try {
    process.exitCode = await runOpsE2e([OPS_MERCHANT_PROVISION_SPEC, '--workers=1'], source, undefined, configureMerchantProvisionFixture)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'OPS_MERCHANT_PROVISION_ISOLATED_RUN_FAILED')
    process.exitCode = 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) void main()
