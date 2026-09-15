import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = 'infra/scripts/pilot-compose-preflight.sh'
const releaseId = 'ecs-release-1'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ecs-storage-evidence-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(bin, 'docker'), 0o755)
  const evidence = join(root, 'evidence.json')
  writeFileSync(evidence, '{}')
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, PILOT_RELEASE_ID: releaseId,
    PILOT_RELEASE_GIT_SHA: 'a'.repeat(40), PILOT_RELEASE_MANIFEST_SHA256: 'b'.repeat(64),
    PILOT_RELEASE_IMAGE_SET_DIGEST: `sha256:${'c'.repeat(64)}`,
    PILOT_RELEASE_CONFIG_SHA256: 'd'.repeat(64), DEPLOYMENT_NONCE: 'ecs_deployment_nonce_123456',
    OBJECT_STORAGE_EVIDENCE_PATH: evidence, PRODUCTION_EVIDENCE_ARTIFACT_ROOT: root,
    ASSET_STORAGE_BUCKET: 'merchant-assets', ASSET_STORAGE_ENDPOINT: 'https://merchant-assets.oss-cn-hangzhou.aliyuncs.com',
    ASSET_SCANNER_SERVICE_ID: 'merchant-asset-scanner-production',
    ASSET_SCAN_APPROVED_SCANNER_SERVICE_IDS: 'merchant-asset-scanner-production',
    ASSET_SCAN_MIN_DEFINITIONS_VERSION: '28000', ASSET_SCAN_POLICY_VERSION: 'scan-policy-v1',
  }
  return { evidence, env }
}

describe('ECS pilot object storage evidence preflight', () => {
  it('fails closed when OBJECT_STORAGE_EVIDENCE_PATH is missing', () => {
    const { env } = fixture()
    delete env.OBJECT_STORAGE_EVIDENCE_PATH
    expect(() => execFileSync('sh', [script], { env, stdio: 'pipe' })).toThrow(/OBJECT_STORAGE_EVIDENCE_PATH is required/)
  })

  it('rejects mutable trust-path overrides before evidence validation', () => {
    const { env } = fixture()
    env.PRODUCTION_EVIDENCE_TRUST_DIR = '/tmp/untrusted'
    expect(() => execFileSync('sh', [script], { env, stdio: 'pipe' })).toThrow(/trust path is fixed/)
  })

  it('fails closed when the fixed production trust anchor is unavailable', () => {
    const { env } = fixture()
    expect(() => execFileSync('sh', [script], { env, encoding: 'utf8', stdio: 'pipe' })).toThrow(/production evidence trust/)
  })

  it('rejects a scan worker identity that the API does not approve', () => {
    const { env } = fixture()
    env.ASSET_SCAN_APPROVED_SCANNER_SERVICE_IDS = 'different-scanner'
    expect(() => execFileSync('sh', [script], { env, encoding: 'utf8', stdio: 'pipe' })).toThrow(/must be present/)
  })

  it('rejects scanner definitions older than the 24 hour production bound', () => {
    const { env } = fixture()
    env.SCANNER_DEFINITIONS_MAX_AGE_SECONDS = '86401'
    expect(() => execFileSync('sh', [script], { env, encoding: 'utf8', stdio: 'pipe' })).toThrow(/must be from 1 to 86400/)
  })
})
