import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { forbiddenCloudPath } from '../infra/scripts/verify-ecs-cloud-only-artifacts.mjs'

const verifier = 'infra/scripts/verify-ecs-cloud-only-artifacts.mjs'

describe('ECS cloud-only artifact boundary', () => {
  it('rejects local plugin source and compiled test trees without rejecting backend plugin data code', () => {
    expect(forbiddenCloudPath('apps/plugin/mcp/bridge.mjs')).toBe('local ChatGPT plugin source')
    expect(forbiddenCloudPath('./.codex-marketplace/plugins/merchant-marketing/mcp/bridge.mjs')).toBe('local ChatGPT plugin source')
    expect(forbiddenCloudPath('app/dist/apps/plugin/mcp/bridge.js', true)).toBe('local ChatGPT plugin source')
    expect(forbiddenCloudPath('app/dist/tests/plugin-manifest.test.js', true)).toBe('compiled test tree')
    expect(forbiddenCloudPath('packages/persistence/src/local-plugin-connection-repository.ts', true)).toBeNull()
    expect(forbiddenCloudPath('apps/api/src/server.ts', true)).toBeNull()
  })

  it('fails a plugin-bearing source tar before inspecting any Docker image or consuming a release nonce', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloud-only-negative-'))
    try {
      const payload = join(directory, 'payload')
      mkdirSync(join(payload, 'apps', 'plugin'), { recursive: true })
      writeFileSync(join(payload, 'apps', 'plugin', 'bridge.mjs'), 'local-only\n')
      const archive = join(directory, 'candidate-source.tar')
      execFileSync('tar', ['-C', payload, '-cf', archive, 'apps'])
      const result = spawnSync('node', [verifier, archive, join(directory, 'missing-compose.yml'), 'bridgeprobe'], { encoding: 'utf8' })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('cloud source archive contains local ChatGPT plugin source')
      const runner = readFileSync('infra/scripts/deploy-ecs-bridge-unlabeled.sh', 'utf8')
      expect(runner.indexOf('verify-ecs-cloud-only-artifacts.mjs" "$ECS_CANDIDATE_SOURCE_ARCHIVE"')).toBeLessThan(runner.indexOf('consume-production-evidence-nonce.sh'))
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
