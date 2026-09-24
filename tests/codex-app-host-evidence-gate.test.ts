import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { validateCodexAppHostEvidence } from './codex-app-host-evidence-gate.js'

const artifact = (name: string) => `artifact://production/codex-host/${name}#${'a'.repeat(64)}`
const evidence = {
  schema_version: '2', release_id: 'release-1', manifest_sha256: '9'.repeat(64), environment: 'preproduction', generated_at: '2026-08-29T01:00:00Z',
  host: 'codex-app-macos-arm64', app_version: '0.150.1', plugin_version: '0.1.0', simulated: false,
  mcp_base_url: 'https://merchant.example.com', bridge_sha256: 'b'.repeat(64),
  scenarios: [
    'plugin_discovery',
    'merchant_start',
    'merchant_payment_status',
    'manual_publish_workflow',
    'asset_attachment',
    'error_recovery',
    'image_generation',
    'automatic_scan',
    'candidate_images_rendered',
    'candidate_primary_cta',
    'candidate_selection_persisted',
    'selection_not_reviewed',
    'selection_not_published',
    'automation_read_only',
    'automation_host_absent',
  ].map(id => ({ id, state: 'passed', evidence_ref: artifact(id), console_errors: 0, network_errors: 0, ...(id === 'error_recovery' ? { error_recovery: { trigger_http_status: 503, trigger_error_code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', request_id: 'request-503', trace_id: 'trace-503', recovery_action: 'query_provider' as const, retry_allowed: false, before_state: 'outcome_unknown' as const, after_state: 'reconciled_failed' as const, reconciliation_required: true, outcome_evidence_ref: artifact('error-recovery-outcome') } } : {}) })),
}

describe('Codex App host evidence gate', () => {
  it('collector emits references relative to the configured artifact root that the gate can verify', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-host-evidence-'))
    const captureDir = join(root, 'real-host-captures')
    mkdirSync(captureDir)
    const scenarioIds = evidence.scenarios.map(({ id }) => id)
    const outcomePath = join(captureDir, 'error-recovery-outcome.json')
    writeFileSync(outcomePath, JSON.stringify({ reconciled: true }))
    const scenarios = scenarioIds.map(id => {
      const artifactPath = join(captureDir, `${id}.json`)
      writeFileSync(artifactPath, JSON.stringify({ id, captured: true }))
      return {
        id, state: 'passed', artifact_path: artifactPath, console_errors: 0, network_errors: 0,
        ...(id === 'error_recovery' ? {
          error_recovery: {
            trigger_http_status: 503, trigger_error_code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN',
            request_id: 'request-503', trace_id: 'trace-503', recovery_action: 'query_provider',
            retry_allowed: false, before_state: 'outcome_unknown', after_state: 'reconciled_failed',
            reconciliation_required: true, outcome_artifact_path: outcomePath,
          },
        } : {}),
      }
    })
    const capturePath = join(root, 'capture.json')
    const outputPath = join(root, 'evidence.json')
    const probePath = join(captureDir, 'releasez.json')
    writeFileSync(probePath, JSON.stringify({ data: { ready: true, release: { release_id: 'release-1', release_git_sha: 'c'.repeat(40), manifest_sha256: '9'.repeat(64), image_set_digest: `sha256:${'d'.repeat(64)}` } } }))
    writeFileSync(capturePath, JSON.stringify({
      release_id: 'release-1', manifest_sha256: '9'.repeat(64), environment: 'preproduction', generated_at: '2026-08-29T01:00:00Z',
      host: 'codex-app-macos-arm64', app_version: '0.150.1', plugin_version: '0.1.0', simulated: false,
      mcp_base_url: 'https://merchant.example.com', bridge_sha256: 'b'.repeat(64), scenarios,
      candidate_route: { expected_git_sha: 'c'.repeat(40), expected_manifest_sha256: '9'.repeat(64), expected_image_set_digest: `sha256:${'d'.repeat(64)}`, candidate_api_container_id: 'e'.repeat(64), gateway_container_id: 'f'.repeat(64), mcp_config_sha256: '1'.repeat(64), route_file_sha256: '2'.repeat(64), release_probe_artifact_path: probePath },
    }))

    const run = spawnSync(process.execPath, [
      resolve('scripts/collect-codex-app-host-evidence.mjs'), '--capture', capturePath,
      '--output', outputPath, '--artifact-root', root,
    ], { encoding: 'utf8' })
    expect(run.status, run.stderr).toBe(0)
    const collected = JSON.parse(readFileSync(outputPath, 'utf8'))
    expect(collected.scenarios[0].evidence_ref).toMatch(/^artifact:\/\/production\/real-host-captures\//u)
    expect(collected.candidate_route.release_probe_evidence_ref).toMatch(/^artifact:\/\/production\/real-host-captures\/releasez\.json#/u)
    expect(collected.manifest_sha256).toBe('9'.repeat(64))
    expect(collected.candidate_route.expected_manifest_sha256).toBe('9'.repeat(64))
    expect(validateCodexAppHostEvidence(collected, {
      expectedReleaseId: 'release-1', expectedMcpBaseUrl: 'https://merchant.example.com',
      expectedManifestSha256: '9'.repeat(64), expectedBridgeSha256: 'b'.repeat(64), expectedGitSha: 'c'.repeat(40), expectedImageSetDigest: `sha256:${'d'.repeat(64)}`, artifactRoot: root,
    })).toEqual([])
    const productionCapture = join(root, 'production-capture.json')
    writeFileSync(productionCapture, JSON.stringify({
      release_id: 'release-1', release_git_sha: 'c'.repeat(40), image_set_digest: `sha256:${'d'.repeat(64)}`,
      manifest_sha256: '9'.repeat(64), environment: 'production', deployment_nonce: 'missing-nonce',
      host: 'codex-app-macos-arm64', app_version: '0.150.1', plugin_version: '0.1.0', simulated: false,
      mcp_base_url: 'https://merchant.example.com', bridge_sha256: 'b'.repeat(64),
    }))
    const missingNonce = spawnSync(process.execPath, [resolve('scripts/collect-codex-app-host-evidence.mjs'), '--capture', productionCapture, '--output', join(root, 'production-evidence.json'), '--artifact-root', root], { encoding: 'utf8' })
    expect(missingNonce.status).toBe(1)
    expect(missingNonce.stderr).toContain('production capture requires the consumed deployment nonce')
    expect(validateCodexAppHostEvidence(collected, { requireFresh: true, artifactRoot: root, now: new Date('2026-08-29T02:00:00Z'), expectedGitSha: 'a'.repeat(40) })).toContain('candidate_route.expected_git_sha must match the release candidate')
    const oldProbe = structuredClone(collected)
    oldProbe.candidate_route.expected_git_sha = 'a'.repeat(40)
    expect(validateCodexAppHostEvidence(oldProbe, { requireFresh: true, artifactRoot: root, now: new Date('2026-08-29T02:00:00Z') })).toContain('candidate_route.release_probe_evidence_ref must contain the frozen candidate /releasez identity')

    const releaseProbeBytes = readFileSync(probePath)
    writeFileSync(probePath, JSON.stringify({ data: { ready: true, release: { release_id: 'release-1', release_git_sha: 'c'.repeat(40), manifest_sha256: '8'.repeat(64), image_set_digest: `sha256:${'d'.repeat(64)}` } } }))
    const mismatchedRun = spawnSync(process.execPath, [
      resolve('scripts/collect-codex-app-host-evidence.mjs'), '--capture', capturePath,
      '--output', join(root, 'mismatched-evidence.json'), '--artifact-root', root,
    ], { encoding: 'utf8' })
    expect(mismatchedRun.status).toBe(1)
    expect(mismatchedRun.stderr).toContain('candidate route probe does not match the frozen release')
    writeFileSync(probePath, releaseProbeBytes)
  })

  it('rejects missing candidate route and reused scenario or reconciliation files', () => {
    expect(validateCodexAppHostEvidence(evidence, { requireFresh: true, now: new Date('2026-08-29T02:00:00Z') })).toContain('candidate_route is required for preproduction host evidence')
    const reused = structuredClone(evidence)
    reused.scenarios[1]!.evidence_ref = reused.scenarios[0]!.evidence_ref
    reused.scenarios.find(({ id }) => id === 'error_recovery')!.error_recovery!.outcome_evidence_ref = reused.scenarios.find(({ id }) => id === 'error_recovery')!.evidence_ref
    expect(validateCodexAppHostEvidence(reused)).toEqual(expect.arrayContaining([
      'merchant_start.evidence_ref must not reuse the release probe or another scenario artifact',
      'error_recovery.outcome_evidence_ref must be a separate reconciliation artifact',
    ]))

    const reconciliationReusesScenario = structuredClone(evidence)
    reconciliationReusesScenario.scenarios.find(({ id }) => id === 'error_recovery')!.error_recovery!.outcome_evidence_ref = reconciliationReusesScenario.scenarios.find(({ id }) => id === 'image_generation')!.evidence_ref
    expect(validateCodexAppHostEvidence(reconciliationReusesScenario)).toContain('error_recovery.outcome_evidence_ref must not reuse another scenario artifact')
  })

  it('accepts only release-bound external host evidence', () => {
    expect(validateCodexAppHostEvidence(evidence, { expectedReleaseId: 'release-1', expectedMcpBaseUrl: 'https://merchant.example.com', expectedBridgeSha256: 'b'.repeat(64) })).toEqual([])
  })

  it('production release validation accepts exact deployed identity and rejects preproduction routes and artifacts', () => {
    const production = { ...structuredClone(evidence), environment: 'production', release_git_sha: 'b'.repeat(40), image_set_digest: `sha256:${'c'.repeat(64)}`, deployment_nonce: 'a'.repeat(22) }
    expect(validateCodexAppHostEvidence(production, { requireProduction: true, requireFresh: true, expectedGitSha: 'b'.repeat(40), expectedImageSetDigest: `sha256:${'c'.repeat(64)}`, expectedDeploymentNonce: 'a'.repeat(22), generatedAfter: new Date('2026-08-29T00:59:00Z'), now: new Date('2026-08-29T02:00:00Z') })).toEqual([])
    expect(validateCodexAppHostEvidence(production, { requireProduction: true, expectedDeploymentNonce: 'b'.repeat(22) })).toContain('deployment_nonce must match the consumed deployment nonce')

    expect(validateCodexAppHostEvidence(evidence, { requireProduction: true })).toContain('environment must be production for production release evidence')

    const routed = { ...production, candidate_route: {} }
    expect(validateCodexAppHostEvidence(routed, { requireProduction: true })).toContain('candidate_route is forbidden in production host evidence')

    const preproductionArtifact = structuredClone(production)
    preproductionArtifact.scenarios[0]!.evidence_ref = `artifact://production/preproduction/${preproductionArtifact.scenarios[0]!.id}.json#${'a'.repeat(64)}`
    expect(validateCodexAppHostEvidence(preproductionArtifact, { requireProduction: true })).toContain('plugin_discovery.evidence_ref must not reference a preproduction artifact')

    const preproductionRecovery = structuredClone(production)
    preproductionRecovery.scenarios.find(({ id }) => id === 'error_recovery')!.error_recovery!.outcome_evidence_ref = `artifact://production/preprod/error-outcome.json#${'c'.repeat(64)}`
    expect(validateCodexAppHostEvidence(preproductionRecovery, { requireProduction: true })).toContain('error_recovery.outcome_evidence_ref must not reference a preproduction artifact')
  })

  it('requires and matches the expected release manifest SHA in host evidence', () => {
    expect(validateCodexAppHostEvidence({ ...evidence, manifest_sha256: undefined }, { expectedManifestSha256: '9'.repeat(64) })).toContain('manifest_sha256 must be a SHA-256 digest')
    expect(validateCodexAppHostEvidence(evidence, { expectedManifestSha256: '8'.repeat(64) })).toContain(`manifest_sha256 must match ${'8'.repeat(64)}`)
  })

  it('requires candidate release probe manifest SHA to match the frozen expected identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-host-manifest-'))
    const captureDir = join(root, 'captures')
    mkdirSync(captureDir)
    const probePath = join(captureDir, 'releasez.json')
    writeFileSync(probePath, JSON.stringify({ data: { ready: true, release: { release_id: 'release-1', release_git_sha: 'c'.repeat(40), image_set_digest: `sha256:${'d'.repeat(64)}` } } }))
    const probeHash = createHash('sha256').update(readFileSync(probePath)).digest('hex')
    const probeRef = `artifact://production/captures/releasez.json#${probeHash}`
    const invalid = { ...evidence, candidate_route: { expected_git_sha: 'c'.repeat(40), expected_manifest_sha256: '9'.repeat(64), expected_image_set_digest: `sha256:${'d'.repeat(64)}`, candidate_api_container_id: 'e'.repeat(64), gateway_container_id: 'f'.repeat(64), mcp_config_sha256: '1'.repeat(64), route_file_sha256: '2'.repeat(64), release_probe_evidence_ref: probeRef } }
    expect(validateCodexAppHostEvidence(invalid, { requireFresh: true, artifactRoot: root, expectedManifestSha256: '9'.repeat(64), now: new Date('2026-08-29T02:00:00Z') })).toContain('candidate_route.release_probe_evidence_ref must contain the frozen candidate /releasez identity')
  })

  it('rejects evidence captured against another MCP origin or bridge', () => {
    expect(validateCodexAppHostEvidence(evidence, { expectedMcpBaseUrl: 'https://other.example.com', expectedBridgeSha256: 'c'.repeat(64) })).toEqual(expect.arrayContaining([
      'mcp_base_url must match the deployment configuration',
      'bridge_sha256 must match the deployed plugin bridge',
    ]))
  })

  it('rejects an ambiguous host capture timestamp', () => {
    expect(validateCodexAppHostEvidence({ ...evidence, generated_at: '2026-08-29' })).toContain('generated_at must be a strict UTC ISO timestamp')
  })

  it('rejects stale or future host captures when used by the production preflight', () => {
    const now = new Date('2026-08-30T02:00:00Z')
    expect(validateCodexAppHostEvidence(evidence, { requireFresh: true, now })).toContain('Codex App host evidence is stale')
    expect(validateCodexAppHostEvidence({ ...evidence, generated_at: '2026-08-30T02:05:01Z' }, { requireFresh: true, now })).toContain('generated_at must not be more than five minutes in the future')
  })

  it.each(['http://merchant.example.com', 'https://user@merchant.example.com', 'https://merchant.example.com/mcp', 'https://merchant.example.com?token=secret', 'https://localhost', 'https://127.0.0.2', 'https://0.0.0.0', 'https://10.0.0.1', 'https://100.64.1.2', 'https://192.168.1.5', 'https://8.8.8.8', 'https://[::ffff:127.0.0.1]'])('rejects unsafe MCP origin %s', mcp_base_url => {
    expect(validateCodexAppHostEvidence({ ...evidence, mcp_base_url })).toContain('mcp_base_url must be a canonical public HTTPS root origin')
  })

  it('requires a release ID when independently validating production artifacts', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-host-required-release-'))
    const file = join(root, 'evidence.json')
    writeFileSync(file, JSON.stringify(evidence))
    const run = spawnSync(process.execPath, [
      '--import', 'tsx', resolve('tests/codex-app-host-evidence-gate.ts'), '--file', file,
      '--artifact-root', root, '--require-artifacts',
      '--expected-mcp-base-url', 'https://merchant.example.com',
      '--expected-bridge-sha256', 'b'.repeat(64),
    ], { encoding: 'utf8' })
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('--release-id, --expected-mcp-base-url, --expected-bridge-sha256, --expected-git-sha')
  })

  it('rejects local/fixture evidence and non-clean scenarios', () => {
    const invalid = structuredClone(evidence)
    invalid.host = 'localhost fixture'
    invalid.scenarios[0]!.state = 'passed'
    invalid.scenarios[0]!.evidence_ref = 'artifact://production/codex-host/plugin_discovery#not-a-sha'
    invalid.scenarios[0]!.console_errors = 1
    expect(validateCodexAppHostEvidence(invalid)).toEqual(expect.arrayContaining([
      'host must identify a real Codex App host, not fixture/local evidence',
      'plugin_discovery.evidence_ref must be an immutable production artifact',
      'plugin_discovery.console_errors must be 0',
    ]))
  })

  it.each(['chrome-desktop', 'electron-shell', 'ios-app', 'arbitrary-external-host'])('rejects a non-ChatGPT host label: %s', host => {
    expect(validateCodexAppHostEvidence({ ...evidence, host })).toContain('host must identify a supported ChatGPT/Codex App host')
  })

  it('rejects host evidence that omits the ChatGPT image selection journey', () => {
    const invalid = structuredClone(evidence)
    invalid.scenarios = invalid.scenarios.filter(({ id }) => id !== 'candidate_images_rendered')
    expect(validateCodexAppHostEvidence(invalid)).toContain('candidate_images_rendered scenario is required')
  })

  it('requires explicit evidence that Automation stays read-only and fails closed without a host', () => {
    const invalid = structuredClone(evidence)
    invalid.scenarios = invalid.scenarios.filter(({ id }) => id !== 'automation_read_only' && id !== 'automation_host_absent')
    expect(validateCodexAppHostEvidence(invalid)).toEqual(expect.arrayContaining([
      'automation_read_only scenario is required',
      'automation_host_absent scenario is required',
    ]))
  })

  it('rejects an error recovery scenario that only claims passed without 503 evidence', () => {
    const invalid = structuredClone(evidence)
    invalid.scenarios.find(({ id }) => id === 'error_recovery')!.error_recovery = { trigger_http_status: 500, retry_allowed: true } as unknown as NonNullable<typeof invalid.scenarios[number]['error_recovery']>
    expect(validateCodexAppHostEvidence(invalid)).toEqual(expect.arrayContaining([
      'error_recovery.trigger_http_status must be 503',
      'error_recovery.trigger_error_code must be MODEL_PROVIDER_OUTCOME_UNKNOWN',
      'error_recovery.retry_allowed must be false',
      'error_recovery.outcome_evidence_ref must be an immutable production artifact',
    ]))
  })
})
