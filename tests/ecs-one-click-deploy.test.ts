import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
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
    expect(source).toContain('docker image prune -f')
    expect(source).not.toMatch(/docker (?:volume prune|system prune)|down -v/u)
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

    const result = spawnSync('sh', [script, 'cleanup'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ECS_RELEASES_ROOT: root, ECS_RELEASE_KEEP_COUNT: '1', CONFIRM_ECS_STORAGE_CLEANUP: 'YES' },
      encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('DELETE\trelease-stale')
    expect(spawnSync('test', ['-e', stale]).status).not.toBe(0)
    expect(readFileSync(join(unknown, 'keep'), 'utf8')).toBe('business data')
  })
})
