import { createHash } from 'node:crypto'

export interface LocalAssetScanFixtureInput {
  assetId: string
  sha256: string
}

export interface LocalAssetScanFixtureDecision {
  mode: 'local_fixture'
  evidenceRef: string
  productionEvidence: false
  label: string
}

/**
 * Local acceptance may automatically promote files that passed the deterministic
 * upload policy. This is deliberately impossible in production and is labelled
 * as fixture evidence so it cannot be mistaken for a malware-scanner attestation.
 */
export function localAssetScanFixture(
  input: LocalAssetScanFixtureInput,
  env: NodeJS.ProcessEnv = process.env,
): LocalAssetScanFixtureDecision | null {
  const enabled = env.NODE_ENV !== 'production'
    && env.DEPLOYMENT_PROFILE === 'local_acceptance'
    && env.LOCAL_COMPOSE === 'true'
    && env.ALLOW_LOCAL_ASSET_SCAN_FIXTURE === 'true'
  if (!enabled) return null
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(input.assetId) || !/^[a-f0-9]{64}$/iu.test(input.sha256)) return null
  const receipt = createHash('sha256').update(`local-asset-scan-fixture-v1\n${input.assetId}\n${input.sha256}`).digest('hex')
  return {
    mode: 'local_fixture',
    evidenceRef: `fixture://local-asset-scan/v1/${receipt}`,
    productionEvidence: false,
    label: '本地演示扫描，不代表生产安全扫描',
  }
}

export function assetScanWaitingState(env: NodeJS.ProcessEnv = process.env) {
  const externallyManaged = env.ASSET_SCAN_AUTOMATION_MODE === 'external_callback' || env.ASSET_SCANNER_MODE === 'clamav_worker'
  return externallyManaged
    ? {
        state: 'pending' as const,
        mode: 'platform_worker' as const,
        userActionRequired: false,
        message: '图片已收到，正在自动进行安全检查。通过后会等待你的确认再继续生成。',
      }
    : {
        state: 'configuration_required' as const,
        mode: 'unconfigured' as const,
        userActionRequired: false,
        message: '当前暂时无法检查图片。图片和任务已保留，没有生成内容，也不会产生费用；请稍后继续。',
      }
}
