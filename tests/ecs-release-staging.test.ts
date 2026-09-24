import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ecs-release-stage-')))
  const repo = join(base, 'repo'); const bundle = join(base, 'bundle'); const releases = join(base, 'releases'); const bin = join(base, 'bin')
  mkdirSync(join(repo, 'infra/scripts'), { recursive: true }); mkdirSync(bundle); mkdirSync(releases); mkdirSync(bin)
  // Keep the unit fixture hermetic. The production script pins the protected
  // 101 runtime; its exact host paths are exercised by the isolated container
  // check, while this fixture substitutes only those paths inside its archive.
  const protectedNode = '/usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node'
  const protectedBin = dirname(protectedNode)
  const protectedNpm = '/usr/lib/node_modules/npm/bin/npm-cli.js'
  const fixtureNpm = join(bin, 'npm-cli.cjs')
  const stagingSource = readFileSync(resolve('infra/scripts/stage-verified-ecs-release.sh'), 'utf8')
  expect(stagingSource).toContain(`STAGING_NODE=${protectedNode}`)
  expect(stagingSource).toContain(`STAGING_NPM_CLI=${protectedNpm}`)
  writeFileSync(join(repo, 'infra/scripts/stage-verified-ecs-release.sh'), stagingSource
    .replaceAll(protectedNode, process.execPath)
    .replaceAll(protectedBin, dirname(process.execPath))
    .replaceAll(protectedNpm, fixtureNpm)
    .replace('[ "$node_version" = v22.23.2 ]', `[ "$node_version" = ${process.version} ]`))
  cpSync(resolve('infra/scripts/ecs-build-lock.sh'), join(repo, 'infra/scripts/ecs-build-lock.sh'))
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
  writeFileSync(fixtureNpm, `const fs = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('10.9.4'); process.exit(0) }
if (args[0] === 'ci') { fs.writeFileSync('.npm-ci-args', args.join('\\n')); process.exit(0) }
if (args[0] === 'run' && args[1] === 'build') {
  setTimeout(() => process.exit(0), Number(process.env.ECS_FIXTURE_NPM_DELAY_MS || 0))
} else process.exit(9)
`)
  return { base, repo, bundle, releases, bin, gitSha }
}

function run(value: ReturnType<typeof fixture>, releaseId = 'release-1') {
  return spawnSync('sh', [join(value.repo, 'infra/scripts/stage-verified-ecs-release.sh')], {
    env: { ...process.env, PATH: `${value.bin}:${process.env.PATH}`, ECS_BUILD_LOCK_PATH: join(value.base, 'build.lock'), ECS_CANDIDATE_BUNDLE_DIR: value.bundle, ECS_RELEASES_ROOT: value.releases, RELEASE_ID: releaseId },
    encoding: 'utf8',
  })
}

describe('verified ECS release staging', () => {
  it('uses Python lstat so the host Python can reject symlinks without requiring Path.stat follow_symlinks support', () => {
    const source = readFileSync(resolve('infra/scripts/stage-verified-ecs-release.sh'), 'utf8')
    expect(source).toContain('cursor.lstat()')
    expect(source).not.toContain('cursor.stat(follow_symlinks=False)')
  })

  it('loads the lock helper beside the entrypoint for standalone ECS installation', () => {
    const source = readFileSync(resolve('infra/scripts/stage-verified-ecs-release.sh'), 'utf8')
    expect(source).toContain('script_dir/ecs-build-lock.sh')
    expect(source).toContain('script_dir/../..')
  })
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
    const invoke = () => new Promise<{ status: number | null; stderr: string }>((resolveResult) => {
      const child = spawn('sh', [join(value.repo, 'infra/scripts/stage-verified-ecs-release.sh')], {
        env: { ...process.env, PATH: `${value.bin}:${process.env.PATH}`, ECS_FIXTURE_NPM_DELAY_MS: '1000', ECS_BUILD_LOCK_PATH: join(value.base, 'build.lock'), ECS_CANDIDATE_BUNDLE_DIR: value.bundle, ECS_RELEASES_ROOT: value.releases, RELEASE_ID: 'release-1' },
      })
      let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk })
      child.on('close', status => resolveResult({ status, stderr }))
    })
    const [first, second] = await Promise.all([invoke(), invoke()])
    expect([first.status, second.status].sort()).toEqual([0, 1])
    expect(first.stderr + second.stderr).toMatch(/staging is already in progress|another ECS source build is in progress/u)
    expect(existsSync(join(value.releases, 'release-1/.candidate-identity'))).toBe(true)
  }, 20_000)

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

  it('rejects a candidate bundle that another local user can replace', () => {
    const value = fixture()
    execFileSync('chmod', ['0777', value.bundle])
    const result = run(value)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('candidate bundle path is replaceable by another user')
    expect(existsSync(join(value.releases, 'release-1'))).toBe(false)
  })
})
