import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = resolve('infra/scripts/ecs-one-click-deploy.sh')

function release(root: string, id: string, age: number) {
  const path = join(root, id)
  mkdirSync(path)
  writeFileSync(join(path, '.candidate-identity'), `release_id=${id}\ngit_sha=${'a'.repeat(40)}\n`)
  execFileSync('touch', ['-t', `202609${String(age).padStart(2, '0')}0000`, path])
  return path
}

describe('ECS one-click deployment storage policy', () => {
  it('is valid shell and deploys before applying cleanup', () => {
    expect(execFileSync('sh', ['-n', script], { encoding: 'utf8' })).toBe('')
    const source = readFileSync(script, 'utf8')
    expect(source.indexOf('sh infra/scripts/deploy-verified-ecs-compose.sh')).toBeLessThan(source.indexOf('CONFIRM_ECS_STORAGE_CLEANUP=YES'))
    expect(source).toContain('ECS_CANDIDATE_IDENTITY_PATH="$destination/.candidate-identity"')
    expect(source).toContain('docker builder prune')
    expect(source).not.toContain('docker image prune')
    expect(source).not.toMatch(/docker (?:volume prune|system prune)|down -v/u)
    expect(source).toContain('docker ps -aq')
    expect(source).toContain("sed -n 's/^RELEASE_ID=//p'")
  })

  it('dry-runs by default, keeps the newest two, and protects explicit releases', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ecs-release-retention-')))
    chmodSync(root, 0o700)
    const oldest = release(root, 'release-oldest', 1)
    const protectedRelease = release(root, 'release-protected', 2)
    release(root, 'release-newer', 3)
    release(root, 'release-newest', 4)
    const bin = join(root, 'bin'); mkdirSync(bin)
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\necho docker-system-df\n', { mode: 0o755 })
    writeFileSync(join(bin, 'flock'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

    const result = spawnSync('sh', [script, 'cleanup'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ECS_RELEASES_ROOT: root, ECS_RELEASE_KEEP_COUNT: '2', ECS_PROTECTED_RELEASE_IDS: 'release-protected' },
      encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('WOULD_DELETE\trelease-oldest')
    expect(result.stdout).toContain('KEEP\trelease-protected')
    expect(readFileSync(join(oldest, '.candidate-identity'), 'utf8')).toContain('release-oldest')
    expect(readFileSync(join(protectedRelease, '.candidate-identity'), 'utf8')).toContain('release-protected')
  })

  it('deletes only validated stale release directories after explicit confirmation', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ecs-release-retention-')))
    chmodSync(root, 0o700)
    const stale = release(root, 'release-stale', 1)
    release(root, 'release-current', 2)
    const unknown = join(root, 'unmanaged'); mkdirSync(unknown); writeFileSync(join(unknown, 'keep'), 'business data')
    const bin = join(root, 'bin'); mkdirSync(bin)
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(bin, 'flock'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

    const result = spawnSync('sh', [script, 'cleanup'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ECS_RELEASES_ROOT: root, ECS_RELEASE_KEEP_COUNT: '1', CONFIRM_ECS_STORAGE_CLEANUP: 'YES' },
      encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('DELETE\trelease-stale')
    expect(spawnSync('test', ['-e', stale]).status).not.toBe(0)
    expect(readFileSync(join(unknown, 'keep'), 'utf8')).toBe('business data')
  })

  it('serializes cleanup across the full one-click mutation workflow', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ecs-release-lock-')))
    chmodSync(root, 0o700)
    writeFileSync(join(root, '.ecs-one-click-mutation.lock'), '', { mode: 0o600 })
    const bin = join(root, 'bin'); mkdirSync(bin)
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(bin, 'flock'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })

    const result = spawnSync('sh', [script, 'cleanup'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ECS_RELEASES_ROOT: root, CONFIRM_ECS_STORAGE_CLEANUP: 'YES' },
      encoding: 'utf8',
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('another ECS one-click deploy or cleanup is already in progress')
  })

  it('reuses an unlocked persistent lock file instead of treating it as stale', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ecs-release-unlocked-')))
    chmodSync(root, 0o700)
    writeFileSync(join(root, '.ecs-one-click-mutation.lock'), '', { mode: 0o600 })
    const bin = join(root, 'bin'); mkdirSync(bin)
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(bin, 'flock'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

    const result = spawnSync('sh', [script, 'cleanup'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ECS_RELEASES_ROOT: root },
      encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
  })

  it('rejects unsafe release IDs and destination symlinks before staging or deployment', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ecs-release-path-')))
    chmodSync(root, 0o700)
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ecs-release-outside-')))
    symlinkSync(outside, join(root, 'release-linked'))
    const bin = join(root, 'bin'); mkdirSync(bin)
    writeFileSync(join(bin, 'flock'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

    for (const releaseId of ['../escape', 'release-linked']) {
      const result = spawnSync('sh', [script, 'deploy'], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          ECS_RELEASES_ROOT: root,
          ECS_CANDIDATE_BUNDLE_DIR: outside,
          RELEASE_ID: releaseId,
        },
        encoding: 'utf8',
      })
      expect(result.status).toBe(2)
      expect(result.stderr).toMatch(/unsafe RELEASE_ID|release destination must not be a symlink/)
    }
  })

  it('rejects incomplete deployment configuration before expensive staging', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ecs-release-config-')))
    chmodSync(root, 0o700)
    const bundle = realpathSync(mkdtempSync(join(tmpdir(), 'ecs-release-bundle-')))
    const bin = join(root, 'bin'); mkdirSync(bin)
    writeFileSync(join(bin, 'flock'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const result = spawnSync('sh', [script, 'deploy'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ECS_RELEASES_ROOT: root, ECS_CANDIDATE_BUNDLE_DIR: bundle, RELEASE_ID: 'release-config-check' },
      encoding: 'utf8',
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('one-click deployment configuration is incomplete')
    expect(result.stderr).toContain('RENDERED_COMPOSE_PATH')
    expect(result.stderr).not.toContain('candidate input must be')
  })
})
