import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('six-platform deployment templates', () => {
  it('keeps staging feature flags explicit for all six platforms', () => {
    const source = readFileSync('infra/config/staging.example.yaml', 'utf8')
    for (const platform of ['jd', 'taobao_tmall', 'pinduoduo', 'xiaohongshu', 'douyin']) {
      expect(source).toContain(`${platform}_auth_enabled: false`)
      expect(source).toContain(`${platform}_read_enabled: false`)
      expect(source).toContain(`${platform}_write_enabled: false`)
    }
  })

  it('keeps social production placeholders fail-closed and media-aware', () => {
    const source = readFileSync('docs/production-config.example.yaml', 'utf8')
    for (const platform of ['xiaohongshu', 'douyin']) {
      expect(source).toContain(`  ${platform}:`)
      expect(source).toContain('media_upload_path: "/documented/media/upload"')
      expect(source).toContain('media_response_mapping: { media_id_path: "data.media_id", media_url_path: "data.url" }')
      expect(source).toContain('capability_evidence_status: blocked_until_production_canary')
    }
  })
})
