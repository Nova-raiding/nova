import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sourceProducers = [
  'infra/scripts/prepare-ecs-candidate-bundle.sh',
  'infra/scripts/build-ecs-candidate-gates-image.sh',
  'infra/scripts/build-ecs-release-images.sh',
  'infra/scripts/deploy-verified-ecs-compose.sh',
] as const

// The four callers must hash identical Git archive bytes. A one-sided change
// makes an otherwise valid candidate fail its image or deployment identity gate.
const archivePathspec = "':(exclude)artifacts' ':(exclude)screenshots'"

describe('ECS canonical source archive', () => {
  it('copies no compiled local-plugin tree into API or worker runtime images', () => {
    for (const [path, app] of [
      ['infra/docker/api.Dockerfile', 'api'],
      ['infra/docker/worker.Dockerfile', 'worker'],
    ] as const) {
      const dockerfile = readFileSync(path, 'utf8')
      const runtime = dockerfile.slice(dockerfile.indexOf('\nFROM node:22-alpine@'))
      expect(runtime).toContain(`COPY --from=build /app/dist/apps/${app} ./dist/apps/${app}`)
      expect(runtime).toContain('COPY --from=build /app/dist/packages ./dist/packages')
      expect(runtime).not.toContain('COPY --from=build /app/dist ./dist')
      expect(runtime).not.toMatch(/COPY\s+apps\s+/u)
      expect(runtime).not.toMatch(/COPY\s+.*apps\/plugin/u)
    }
  })

  it('uses the same evidence exclusions at every archive producer and verifier', () => {
    for (const path of sourceProducers) {
      const script = readFileSync(path, 'utf8')
      expect(script, `${path} must use the canonical archive pathspec`).toContain(archivePathspec)
      expect(script.match(/git -C "\$root" archive --format=tar/g), `${path} must have one v1 call and at most one explicit v2 call`).toHaveLength(path.includes('prepare-ecs-candidate-bundle') ? 2 : 1)
    }
  })

  it('keeps the v2 cloud archive free of local plugin source while retaining API/MCP and desktop operations', () => {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const archive = spawnSync('git', ['archive', '--format=tar', revision,
      ':(exclude)artifacts', ':(exclude)screenshots', ':(exclude)apps/plugin', ':(exclude).codex-marketplace'], {
      maxBuffer: 128 * 1024 * 1024,
    })
    expect(archive.status, archive.stderr.toString()).toBe(0)
    const members = spawnSync('tar', ['-tf', '-'], { input: archive.stdout, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    expect(members.status, members.stderr).toBe(0)
    const paths = members.stdout.split('\n')
    expect(paths.some(path => path.startsWith('apps/plugin/') || path.startsWith('.codex-marketplace/'))).toBe(false)
    for (const path of ['apps/api/src/server.ts', 'apps/worker/src/main.ts', 'apps/ops-console/package.json',
      'demo/merchant-studio/package.json', 'packages/contracts/src/mcp.ts', 'scripts/plugin-release-descriptor.mjs']) {
      expect(paths).toContain(path)
    }
  })

  it('keeps tracked delivery artifacts out of the actual candidate tar while retaining runtime and gate inputs', () => {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const archive = spawnSync('git', ['archive', '--format=tar', revision, ':(exclude)artifacts', ':(exclude)screenshots'], {
      maxBuffer: 128 * 1024 * 1024,
    })
    expect(archive.status, archive.stderr.toString()).toBe(0)
    const members = spawnSync('tar', ['-tf', '-'], { input: archive.stdout, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    expect(members.status, members.stderr).toBe(0)
    const paths = members.stdout.split('\n')
    expect(paths.some(path => path.startsWith('artifacts/') || path.startsWith('screenshots/'))).toBe(false)
    for (const path of [
      'apps/api/src/server.ts',
      'apps/worker/src/main.ts',
      'apps/ops-console/package.json',
      'demo/merchant-studio/package.json',
      'packages/persistence/src/migration.ts',
      'infra/scripts/deploy-verified-ecs-compose.sh',
      'apps/plugin/mcp/bridge.mjs',
    ]) expect(paths, `${path} is still needed for a build or release gate`).toContain(path)
  })
})
