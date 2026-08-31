import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const deployPath = 'infra/scripts/deploy-verified-manifest.sh'
const rollbackPath = 'infra/scripts/rollback.sh'
const source = (path: string) => readFileSync(path, 'utf8')

describe('scanner release and rollback gates', () => {
  it.each([deployPath, rollbackPath])('%s rolls out and accepts the real scanner topology', path => {
    const script = source(path)
    expect(script).toMatch(/merchant-worker-reconcile merchant-worker-automation merchant-worker-scan/)
    expect(script).toContain('deployment/merchant-worker-generation')
    expect(script).toContain('WORKER_ROLE=generation')
    expect(script).toContain('WORKER_ROLE=scan')
    expect(script).not.toContain('WORKER_ROLE=all')
    expect(script).toContain('app.kubernetes.io/name=merchant-worker-scan')
    expect(script).toContain('scanner_pod_count')
    expect(script).toContain('scanner-heartbeat/1.0')
    expect(script).toContain('Eicar-Test-Signature')
    expect(script).toContain('heartbeat.clamav')
    expect(script).toContain('heartbeat.callback')
    expect(execFileSync('sh', ['-n', path], { encoding: 'utf8' })).toBe('')
  })

  it('exercises the current scanner request-proof contract for GET and callback POST', () => {
    const script = source(deployPath)
    for (const header of ['x-scanner-timestamp', 'x-scanner-nonce', 'x-scanner-body-sha256', 'x-scanner-workspace-signature']) expect(script).toContain(header)
    expect(script).toContain('verifyProof("GET"')
    expect(script).toContain('verifyProof("POST"')
    expect(script).toContain('[method, path, workspaceId, timestamp, nonce, digest].join("\\n")')
    expect(script).toContain('observed[0] === observed[1]')
  })

  it('blocks an incompatible rollback image before applying its manifest', () => {
    const script = source(rollbackPath)
    const compatibilityGate = script.indexOf('rollback_worker_image=$(ruby')
    const rollbackApply = script.indexOf('kubectl apply -f "$verified_manifest"')
    expect(compatibilityGate).toBeGreaterThan(0)
    expect(rollbackApply).toBeGreaterThan(compatibilityGate)
    expect(script).toContain('version = 84')
    expect(script).toContain('migration tail is older than the live database')
    expect(script).toContain('asset-scan-receipt/1.0')
    expect(script).toContain('PostgresAssetScanAttemptRepository')
    expect(script).toContain('executeAssetScan')
    expect(script).toContain('rollback scanner HMAC body digest is invalid')
    expect(script).toContain('rollback image failed scanner and migration compatibility gate')
    expect(script).toMatch(/worker\.image = process\.env\.ROLLBACK_WORKER_IMAGE/)
  })
})
