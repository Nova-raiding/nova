import { describe, expect, it } from 'vitest'
import { PROTECTED_OPS_PATHS, STRUCTURE_REVIEW_PATHS } from '../infra/scripts/ecs-review-structure.mjs'
import { isAllowlistedReviewSource } from '../infra/scripts/ecs-review-source-policy.mjs'

describe('ECS source-only remote review policy', () => {
  it('allows application and library source files only', () => {
    for (const path of [
      'apps/api/src/server.ts', 'apps/ops-console/src/App.tsx',
      'apps/ops-console/vite.config.ts',
      'demo/merchant-studio/src/App.tsx', 'packages/ai/src/relay-usage.ts',
      'packages/persistence/src/migrations/245_local_plugin_authorized_timestamp.sql',
      'scripts/model-relay-recovery-evidence.ts',
    ]) expect(isAllowlistedReviewSource(path), path).toBe(true)
  })

  it('classifies root Ops release inputs without treating templates or docs as executable source', () => {
    expect(PROTECTED_OPS_PATHS).toContain('apps/ops-console/.env.example')
    expect(STRUCTURE_REVIEW_PATHS).toContain('apps/ops-console/README.md')
    expect(isAllowlistedReviewSource('apps/ops-console/vite.config.ts')).toBe(true)
    expect(isAllowlistedReviewSource('apps/ops-console/.env.example')).toBe(false)
    expect(isAllowlistedReviewSource('apps/ops-console/README.md')).toBe(false)
  })

  it('refuses production Compose, environment, secrets, evidence, and non-source paths', () => {
    for (const path of [
      'infra/local/docker-compose.ecs-pilot.yml', 'infra/local/docker-compose.ecs-oss-cutover.yml',
      '.env', '.env.production', 'apps/api/src/private-key.ts', 'artifacts/production/evidence.json',
      'apps/api/package.json', 'docs/runbooks/ecs-candidate-safe-sync.md',
      'apps/api/src/../../etc/passwd', '/etc/passwd', 'scripts/deploy.sh',
    ]) expect(isAllowlistedReviewSource(path), path).toBe(false)
  })

  it('makes the acquisition protocol remote-read-only and no-follow', async () => {
    const { readFileSync } = await import('node:fs')
    const script = readFileSync('infra/scripts/acquire-ecs-review-source.mjs', 'utf8')
    expect(script).toContain("'BatchMode=yes'")
    expect(script).toContain('os.O_NOFOLLOW')
    expect(script).toContain('stat.S_ISREG')
    expect(script).toContain('remote_read_only: true')
    expect(script).not.toMatch(/\b(?:rsync|scp|docker)\b/u)
    expect(script).toContain('const command = `cd --')
    expect(script).not.toContain('process.stderr.write(transfer.stderr')
  })
})
