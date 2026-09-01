import { describe, expect, it } from 'vitest'
import { validateCodexAppHostEvidence } from './codex-app-host-evidence-gate.js'

const artifact = (name: string) => `artifact://production/codex-host/${name}#${'a'.repeat(64)}`
const evidence = {
  schema_version: '2', release_id: 'release-1', environment: 'preproduction', generated_at: '2026-08-29T01:00:00Z',
  host: 'codex-app-macos-arm64', app_version: '0.150.1', plugin_version: '0.1.0', simulated: false,
  mcp_base_url: 'https://merchant.example.com', bridge_sha256: 'b'.repeat(64),
  scenarios: [
    'plugin_discovery',
    'merchant_start',
    'wallet_recharge_entry',
    'platform_oauth_entry',
    'asset_attachment',
    'error_recovery',
    'image_generation',
    'automatic_scan',
    'candidate_images_rendered',
    'candidate_primary_cta',
    'candidate_selection_persisted',
    'selection_not_reviewed',
    'selection_not_published',
  ].map(id => ({ id, state: 'passed', evidence_ref: artifact(id), console_errors: 0, network_errors: 0 })),
}

describe('Codex App host evidence gate', () => {
  it('accepts only release-bound external host evidence', () => {
    expect(validateCodexAppHostEvidence(evidence, { expectedReleaseId: 'release-1', expectedMcpBaseUrl: 'https://merchant.example.com', expectedBridgeSha256: 'b'.repeat(64) })).toEqual([])
  })

  it('rejects evidence captured against another MCP origin or bridge', () => {
    expect(validateCodexAppHostEvidence(evidence, { expectedMcpBaseUrl: 'https://other.example.com', expectedBridgeSha256: 'c'.repeat(64) })).toEqual(expect.arrayContaining([
      'mcp_base_url must match the deployment configuration',
      'bridge_sha256 must match the deployed plugin bridge',
    ]))
  })

  it.each(['http://merchant.example.com', 'https://user@merchant.example.com', 'https://merchant.example.com/mcp', 'https://merchant.example.com?token=secret', 'https://localhost', 'https://10.0.0.1', 'https://192.168.1.5'])('rejects unsafe MCP origin %s', mcp_base_url => {
    expect(validateCodexAppHostEvidence({ ...evidence, mcp_base_url })).toContain('mcp_base_url must be a canonical public HTTPS root origin')
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

  it('rejects host evidence that omits the ChatGPT image selection journey', () => {
    const invalid = structuredClone(evidence)
    invalid.scenarios = invalid.scenarios.filter(({ id }) => id !== 'candidate_images_rendered')
    expect(validateCodexAppHostEvidence(invalid)).toContain('candidate_images_rendered scenario is required')
  })
})
