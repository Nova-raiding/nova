import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const script = new URL('./generate-no-load-capacity-declaration.mjs', import.meta.url)

function fixtureDirectory() {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'no-load-capacity-'))
  chmodSync(directory, 0o700)
  return directory
}

function args(output, overrides = {}) {
  return {
    '--release-id': 'release-candidate-20260928',
    '--confirm-release-id': 'release-candidate-20260928',
    '--verified-by': 'release-owner@example.test',
    '--software-version': 'git:0123456789abcdef0123456789abcdef01234567',
    '--config-version': 'compose:abcdef0123456789',
    '--data-version': 'migration:255',
    '--target-url': 'https://yxsona.com',
    '--expires-at': new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    '--output': output,
    ...overrides,
  }
}

function run(directory, overrides = {}) {
  const output = overrides['--output'] ?? join(directory, 'no-load.json')
  const values = args(output, overrides)
  const cliArgs = Object.entries(values).flatMap(([name, value]) => [name, value])
  const child = spawnSync(process.execPath, [script.pathname, ...cliArgs], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 60_000 })
  return { output, status: child.status, stdout: child.stdout, stderr: child.stderr, error: child.error }
}

test('creates only a release-bound unsigned no_load declaration and validates it with the existing gate', t => {
  const directory = fixtureDirectory()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const result = run(directory)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /existing capacity gate validated --profile no_load/u)
  assert.match(result.stdout, /unsigned no_load declaration created/u)
  const declaration = JSON.parse(readFileSync(result.output, 'utf8'))
  assert.deepEqual(Object.keys(declaration).sort(), [
    'capacity_commitment', 'cloud_gate', 'config_version', 'data_version', 'ended_at', 'environment', 'expires_at',
    'generated_at', 'profile', 'reason', 'release_id', 'schema_version', 'scope', 'sign_off', 'software_version',
    'started_at', 'status', 'target_url',
  ].sort())
  assert.deepEqual(declaration, {
    schema_version: '1', status: 'not_performed', release_id: 'release-candidate-20260928',
    software_version: 'git:0123456789abcdef0123456789abcdef01234567', config_version: 'compose:abcdef0123456789',
    data_version: 'migration:255', environment: 'production', target_url: 'https://yxsona.com',
    started_at: declaration.started_at, ended_at: declaration.started_at, expires_at: declaration.expires_at,
    generated_at: declaration.started_at, profile: 'no_load', cloud_gate: false, scope: 'no_load',
    capacity_commitment: 'none', reason: 'load_testing_excluded_by_release_scope',
    sign_off: { verified_by: 'release-owner@example.test', verified_at: declaration.started_at },
  })
  assert.equal(Object.hasOwn(declaration, 'signature_base64'), false)
  assert.equal(statSync(result.output).mode & 0o777, 0o600)
})

test('requires exact release confirmation and refuses unsafe or stale production inputs before writing', t => {
  const directory = fixtureDirectory()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  for (const overrides of [
    { '--confirm-release-id': 'release-other' },
    { '--target-url': 'https://staging.yxsona.com' },
    { '--expires-at': '2020-01-01T00:00:00Z' },
    { '--data-version': '' },
  ]) {
    const result = run(directory, overrides)
    assert.notEqual(result.status, 0, JSON.stringify(overrides))
    assert.equal(lstatSync(directory).isDirectory(), true)
    assert.equal(existsSync(join(directory, 'no-load.json')), false)
  }
})

test('does not overwrite a regular file or follow a symlink output', t => {
  const directory = fixtureDirectory()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const existing = join(directory, 'existing.json')
  writeFileSync(existing, 'keep-me', { mode: 0o600 })
  const overwrite = run(directory, { '--output': existing })
  assert.notEqual(overwrite.status, 0)
  assert.equal(readFileSync(existing, 'utf8'), 'keep-me')

  const target = join(directory, 'target.json')
  writeFileSync(target, 'do-not-follow', { mode: 0o600 })
  const link = join(directory, 'link.json')
  symlinkSync(target, link)
  const linked = run(directory, { '--output': link })
  assert.notEqual(linked.status, 0)
  assert.equal(readFileSync(target, 'utf8'), 'do-not-follow')
  assert.equal(lstatSync(link).isSymbolicLink(), true)
})

test('requires owner-only output directory mode 0700', t => {
  const directory = fixtureDirectory()
  t.after(() => { chmodSync(directory, 0o700); rmSync(directory, { recursive: true, force: true }) })
  chmodSync(directory, 0o770)
  const result = run(directory)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /must have mode 0700/u)
  assert.equal(existsSync(join(directory, 'no-load.json')), false)
})
