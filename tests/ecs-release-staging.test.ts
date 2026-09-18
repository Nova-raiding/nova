import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ecs-release-stage-')))
  const repo = join(base, 'repo'); const bundle = join(base, 'bundle'); const releases = join(base, 'releases'); const bin = join(base, 'bin')
  mkdirSync(join(repo, 'infra/scripts'), { recursive: true }); mkdirSync(bundle); mkdirSync(releases); mkdirSync(bin)
  cpSync(resolve('infra/scripts/stage-verified-ecs-release.sh'), join(repo, 'infra/scripts/stage-verified-ecs-release.sh'))
  writeFileSync(join(repo, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n')
  writeFileSync(join(repo, 'package-lock.json'), '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.0.0"}}}\n')
  writeFileSync(join(repo, 'source.txt'), 'committed release bytes\n')
  execFileSync('git', ['init', '-q'], { cwd: repo }); execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'candidate'], { cwd: repo })
  const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  execFileSync('git', ['archive', '--format=tar', '-o', join(bundle, 'candidate-source.tar'), gitSha], { cwd: repo })
  writeFileSync(join(bundle, 'files.txt'), 'package.json\npackage-lock.json\nsource.txt\n')
  writeFileSync(join(bundle, 'sync-plan.tsv'), 'status\tpath\nsame\tsource.txt\n')
  const archive = readFileSync(join(bundle, 'candidate-source.tar'))
  writeFileSync(join(bundle, 'candidate-identity.txt'), [
    `git_sha=${gitSha}`,
    `source_sha256=sha256:${sha(archive)}`,
    `comparison_manifest_sha256=sha256:${sha(readFileSync(join(bundle, 'files.txt')))}`,
    `sync_plan_sha256=sha256:${sha(readFileSync(join(bundle, 'sync-plan.tsv')))}`,
    '',
  ].join('\n'))
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\ncase "$1" in\n  ci) printf "%s\\n" "$@" > .npm-ci-args ;;\n  run) [ "$2" = build ] || exit 9 ;;\n  *) exit 9 ;;\nesac\n', { mode: 0o755 })
  return { base, repo, bundle, releases, bin, gitSha }
}

function run(value: ReturnType<typeof fixture>, releaseId = 'release-1') {
  return spawnSync('sh', [join(value.repo, 'infra/scripts/stage-verified-ecs-release.sh')], {
    env: { ...process.env, PATH: `${value.bin}:${process.env.PATH}`, ECS_CANDIDATE_BUNDLE_DIR: value.bundle, ECS_RELEASES_ROOT: value.releases, RELEASE_ID: releaseId },
    encoding: 'utf8',
  })
}

describe('verified ECS release staging', () => {
  it('verifies the archive identity, installs from the lock and atomically creates a new checkout', () => {
    const value = fixture(); const result = run(value)
    expect(result.status, result.stderr).toBe(0)
    const release = join(value.releases, 'release-1')
    expect(readFileSync(join(release, 'source.txt'), 'utf8')).toBe('committed release bytes\n')
    expect(readFileSync(join(release, '.candidate-identity'), 'utf8')).toContain(`git_sha=${value.gitSha}`)
    expect(readFileSync(join(release, '.candidate-identity'), 'utf8')).toContain('release_id=release-1')
    expect(readFileSync(join(release, '.npm-ci-args'), 'utf8')).toContain('--ignore-scripts')
    expect(existsSync(join(release, '.candidate-source.tar'))).toBe(true)
  })

  it('serializes concurrent attempts for the same release identity', async () => {
    const value = fixture()
    writeFileSync(join(value.bin, 'npm'), '#!/bin/sh\nsleep 1\n', { mode: 0o755 })
    const invoke = () => new Promise<{ status: number | null; stderr: string }>((resolveResult) => {
      const child = spawn('sh', [join(value.repo, 'infra/scripts/stage-verified-ecs-release.sh')], {
        env: { ...process.env, PATH: `${value.bin}:${process.env.PATH}`, ECS_CANDIDATE_BUNDLE_DIR: value.bundle, ECS_RELEASES_ROOT: value.releases, RELEASE_ID: 'release-1' },
      })
      let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk })
      child.on('close', status => resolveResult({ status, stderr }))
    })
    const [first, second] = await Promise.all([invoke(), invoke()])
    expect([first.status, second.status].sort()).toEqual([0, 2])
    expect(first.stderr + second.stderr).toContain('staging is already in progress')
    expect(existsSync(join(value.releases, 'release-1/.candidate-identity'))).toBe(true)
  })

  it('fails closed on changed comparison bytes and never leaves the target behind', () => {
    const value = fixture(); writeFileSync(join(value.bundle, 'files.txt'), 'tampered\n')
    const result = run(value)
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('comparison manifest digest mismatch')
    expect(existsSync(join(value.releases, 'release-1'))).toBe(false)
  })

  it('never overwrites an existing release directory', () => {
    const value = fixture(); mkdirSync(join(value.releases, 'release-1')); writeFileSync(join(value.releases, 'release-1/keep'), 'keep')
    const result = run(value)
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('refusing to overwrite')
    expect(readFileSync(join(value.releases, 'release-1/keep'), 'utf8')).toBe('keep')
  })

  it('requires a repository-external release root and safe release id', () => {
    const value = fixture()
    const inside = spawnSync('sh', [join(value.repo, 'infra/scripts/stage-verified-ecs-release.sh')], { env: { ...process.env, PATH: `${value.bin}:${process.env.PATH}`, ECS_CANDIDATE_BUNDLE_DIR: value.bundle, ECS_RELEASES_ROOT: value.repo, RELEASE_ID: 'release-1' }, encoding: 'utf8' })
    expect(inside.status).not.toBe(0); expect(inside.stderr).toContain('outside the mutable repository')
    const unsafe = run(value, '../active'); expect(unsafe.status).not.toBe(0); expect(unsafe.stderr).toContain('unsafe RELEASE_ID')
  })

  it('rejects a release root writable by other users', () => {
    const value = fixture()
    execFileSync('chmod', ['0777', value.releases])
    const result = run(value)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('must not be writable by group or other users')
  })
})
