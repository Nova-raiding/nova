import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('six-platform deployment templates', () => {
  it('keeps the production identity boundary aligned with the config gate', () => {
    const source = readFileSync('doc/todo/infra/production-config.example.yaml', 'utf8')
    expect(source).toContain('  auth_enforcement: strict')
    expect(source).toContain(
      '  session_id_hash_secret_ref: "vault://merchant-identity/session-id-hash-secret"',
    )
  })

  it('keeps staging feature flags explicit for all six platforms', () => {
    const source = readFileSync('infra/config/staging.example.yaml', 'utf8')
    for (const platform of ['jd', 'taobao_tmall', 'pinduoduo', 'xiaohongshu', 'douyin']) {
      expect(source).toContain(`${platform}_auth_enabled: false`)
      expect(source).toContain(`${platform}_read_enabled: false`)
      expect(source).toContain(`${platform}_write_enabled: false`)
    }
  })

  it('keeps social production placeholders fail-closed and media-aware', () => {
    const source = readFileSync('doc/todo/infra/production-config.example.yaml', 'utf8')
    for (const platform of ['xiaohongshu', 'douyin']) {
      expect(source).toContain(`  ${platform}:`)
      expect(source).toContain('media_upload_path: "/documented/media/upload"')
      expect(source).toContain('media_response_mapping: { media_id_path: "data.media_id", media_url_path: "data.url" }')
      expect(source).toContain('capability_evidence_status: blocked_until_production_canary')
    }
  })

  it('documents the production scanner identity, definitions floor, and secret-reference boundary', () => {
    const source = readFileSync('doc/todo/infra/production-config.example.yaml', 'utf8')
    expect(source).toContain('    service_id: "merchant-asset-scanner-production"')
    expect(source).toContain('    approved_service_ids: ["merchant-asset-scanner-production"]')
    expect(source).toContain('    minimum_definitions_version: 28000')
    expect(source).toContain('    minimum_ready_replicas: 2')
    expect(source).toContain('    api_token_ref: "vault://merchant-scanner/api-token"')
    expect(source).toContain('    workspace_signing_secret_ref: "vault://merchant-scanner/workspace-signing-secret"')
    expect(source).toContain('    trusted_public_keys_ref: "vault://merchant-scanner/trusted-public-keys"')
  })
})
