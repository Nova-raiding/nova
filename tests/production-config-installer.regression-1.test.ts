import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// Regression: installer trusted lexical paths and silently appended partial locator patches.
// Found by /qa on 2026-09-15. Fixtures only: never execute deployment launchers.
const roots: string[] = []
const marker = 'config_path=${1:-${PRODUCTION_CONFIG_PATH:-}}'
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'production-installer-regression-'))
  roots.push(root)
  mkdirSync(resolve(root, 'infra/scripts'), { recursive: true })
  mkdirSync(resolve(root, 'deploy/production-config'), { recursive: true })
  const config = resolve(root, 'deploy/production-config/production.yaml')
  const locator = resolve(root, '.env.production-config-path')
  const entry = resolve(root, 'infra/scripts/launch-preflight.sh')
  const backup = resolve(root, 'deploy/production-config/launch-preflight.before-locator.sh')
  const original = `#!/bin/sh\nset -eu\n${marker}\n# .env.production-config-path unsupported\n# preserve custom deployment\n`
  writeFileSync(config, 'configuration_status: BLOCKED_UNTIL_REQUIRED_PRODUCTION_INPUTS\n', { mode: 0o600 })
  writeFileSync(locator, `${config}\n`, { mode: 0o600 })
  writeFileSync(entry, original, { mode: 0o751 })
  return { root, config, locator, entry, backup, original }
}
const run = (root: string) => spawnSync(process.execPath, ['infra/scripts/install-production-config-locator.mjs', root], { encoding: 'utf8' })
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function assertRefusedUnchanged(value: ReturnType<typeof fixture>) {
  const before = { config: lstatSync(value.config).isDirectory() ? undefined : readFileSync(value.config), locator: readFileSync(value.locator), entry: lstatSync(value.entry).isDirectory() ? undefined : readFileSync(value.entry), scripts: readdirSync(resolve(value.root, 'infra/scripts')), backups: readdirSync(resolve(value.root, 'deploy/production-config')) }
  const result = run(value.root)
  expect(result.status).toBe(1)
  expect(result.stdout).not.toContain('installed')
  expect(readFileSync(value.locator)).toEqual(before.locator)
  if (before.entry) expect(readFileSync(value.entry)).toEqual(before.entry)
  if (before.config) expect(readFileSync(value.config)).toEqual(before.config)
  expect(readdirSync(resolve(value.root, 'infra/scripts'))).toEqual(before.scripts)
  expect(readdirSync(resolve(value.root, 'deploy/production-config'))).toEqual(before.backups)
}

describe('production locator installer preflight', () => {
  it('installs only the exact block, preserves modes/config/locator, backs up with wx and is idempotent', () => {
    const value = fixture()
    const config = readFileSync(value.config); const locator = readFileSync(value.locator)
    expect(run(value.root).status).toBe(0)
    const installed = readFileSync(value.entry)
    expect(installed.toString()).toContain('IFS= read -r config_path')
    expect(installed.toString()).toContain('# preserve custom deployment')
    expect(readFileSync(value.backup, 'utf8')).toBe(value.original)
    expect(statSync(value.entry).mode & 0o777).toBe(0o751)
    expect(statSync(value.backup).mode & 0o777).toBe(0o600)
    expect(run(value.root).status).toBe(0)
    expect(readFileSync(value.entry)).toEqual(installed)
    expect(readFileSync(value.config)).toEqual(config)
    expect(readFileSync(value.locator)).toEqual(locator)
  })

  it('rejects canonical config targets escaping the explicit root through a symlink', () => {
    const value = fixture(); const outside = fixture()
    rmSync(value.config)
    symlinkSync(outside.config, value.config)
    assertRefusedUnchanged(value)
    expect(lstatSync(value.config).isSymbolicLink()).toBe(true)
    expect(readFileSync(outside.config, 'utf8')).toContain('BLOCKED_UNTIL_')
  })

  it('accepts managed in-root locator symlinks without replacing links or modifying target bytes/mode', () => {
    const value = fixture(); const target = resolve(value.root, 'deploy/production-config/managed-locator')
    const content = readFileSync(value.locator)
    writeFileSync(target, content, { mode: 0o600 }); rmSync(value.locator); symlinkSync(target, value.locator)
    const link = readlinkSync(value.locator)
    expect(run(value.root).status).toBe(0)
    const installed = readFileSync(value.entry)
    expect(run(value.root).status).toBe(0)
    expect(readFileSync(value.entry)).toEqual(installed)
    expect(lstatSync(value.locator).isSymbolicLink()).toBe(true)
    expect(readlinkSync(value.locator)).toBe(link)
    expect(readFileSync(target)).toEqual(content)
    expect(statSync(target).mode & 0o777).toBe(0o600)
  })

  it('rejects escaping locator symlinks with no backup writes or changes to the existing link/target', () => {
    const value = fixture(); const outside = fixture()
    writeFileSync(outside.locator, `${value.config}\n`, { mode: 0o600 })
    const content = readFileSync(outside.locator)
    rmSync(value.locator); symlinkSync(outside.locator, value.locator)
    const link = readlinkSync(value.locator)
    assertRefusedUnchanged(value)
    expect(readlinkSync(value.locator)).toBe(link)
    expect(readFileSync(outside.locator)).toEqual(content)
    expect(statSync(outside.locator).mode & 0o777).toBe(0o600)
  })

  it.each(['dangling', 'directory'])('rejects %s locator symlinks without modifying launcher or creating backup', kind => {
    const value = fixture()
    const target = resolve(value.root, `deploy/production-config/${kind}-locator`)
    if (kind === 'directory') mkdirSync(target)
    rmSync(value.locator); symlinkSync(target, value.locator)
    const link = readlinkSync(value.locator)
    const before = readFileSync(value.entry); const backups = readdirSync(resolve(value.root, 'deploy/production-config'))
    expect(run(value.root).status).toBe(1)
    expect(readFileSync(value.entry)).toEqual(before)
    expect(readlinkSync(value.locator)).toBe(link)
    expect(readdirSync(resolve(value.root, 'deploy/production-config'))).toEqual(backups)
  })

  it('rejects config directories before creating any backup or temp file', () => {
    const value = fixture(); rmSync(value.config); mkdirSync(value.config)
    assertRefusedUnchanged(value)
  })

  it.each(['\nextra=business-shell-text\n', '\n\n', '\n$(touch should-never-exist)\n'])('rejects extra locator lines %j without evaluating or overwriting them', extra => {
    const value = fixture(); writeFileSync(value.locator, `${value.config}${extra}`)
    assertRefusedUnchanged(value)
  })

  it('rejects a symlink launcher even when its target is inside the explicit root', () => {
    const value = fixture(); const target = resolve(value.root, 'infra/scripts/actual.sh')
    writeFileSync(target, value.original); rmSync(value.entry); symlinkSync(target, value.entry)
    assertRefusedUnchanged(value)
    expect(lstatSync(value.entry).isSymbolicLink()).toBe(true)
  })

  it('rejects launcher directories without writing a backup or replacing the directory', () => {
    const value = fixture(); rmSync(value.entry); mkdirSync(value.entry)
    assertRefusedUnchanged(value)
    expect(lstatSync(value.entry).isDirectory()).toBe(true)
  })

  it.each(['IFS= read -r config_path < "$root/.env.production-config-path"', 'case "$config_path" in', 'export PRODUCTION_CONFIG_PATH="$config_path"', marker])('rejects partial or duplicate locator patches %j before writes', partial => {
    const value = fixture(); writeFileSync(value.entry, `${value.original}${partial}\n`)
    assertRefusedUnchanged(value)
  })

  it('rejects an otherwise supported block with a duplicate locator block rather than returning idempotent success', () => {
    const value = fixture(); expect(run(value.root).status).toBe(0)
    const installed = readFileSync(value.entry, 'utf8')
    const fullBlock = installed.slice(installed.indexOf(marker) + marker.length, installed.indexOf('# .env.production-config-path unsupported'))
    writeFileSync(value.entry, installed + fullBlock)
    const backup = readFileSync(value.backup)
    assertRefusedUnchanged(value)
    expect(readFileSync(value.backup)).toEqual(backup)
  })

  it('preserves a pre-existing backup and busy locator exactly', () => {
    const value = fixture(); writeFileSync(value.backup, 'existing operator backup\n')
    assertRefusedUnchanged(value)
    expect(readFileSync(value.backup, 'utf8')).toBe('existing operator backup\n')
    writeFileSync(value.locator, `${value.config}\noperator-owned-extra\n`)
    assertRefusedUnchanged(value)
  })
})
