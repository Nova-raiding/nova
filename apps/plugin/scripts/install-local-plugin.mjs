#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const defaultSourceRoot = resolve(scriptDirectory, '..')
const defaultRepositoryRoot = resolve(defaultSourceRoot, '..', '..')
const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]
  const value = process.argv[index + 1]
  if (!name?.startsWith('--') || !value) throw new Error(`invalid argument: ${name ?? ''}`)
  args.set(name.slice(2), value)
}

const sourceRoot = resolve(args.get('source') ?? defaultSourceRoot)
const localSourceRoot = resolve(args.get('local-source') ?? resolve(defaultRepositoryRoot, '.codex-marketplace'))
const codex = args.get('codex') ?? 'codex'
const codexHome = resolve(args.get('codex-home') ?? process.env.CODEX_HOME ?? resolve(process.env.HOME ?? '', '.codex'))
const manifest = JSON.parse(readFileSync(resolve(sourceRoot, '.codex-plugin/plugin.json'), 'utf8'))
const packageJson = JSON.parse(readFileSync(resolve(sourceRoot, 'package.json'), 'utf8'))
const version = String(manifest.version ?? '')
const plugin = String(manifest.id ?? '')

if (!existsSync(resolve(localSourceRoot, 'marketplace.json'))) throw new Error(`local plugin source adapter is missing: ${localSourceRoot}`)
if (plugin !== 'merchant-marketing') throw new Error('local package manifest id must be merchant-marketing')
if (!/^\d+\.\d+\.\d+(?:[+-][0-9A-Za-z.-]+)?$/u.test(version)) throw new Error('local package version is missing or invalid')
if (String(packageJson.version ?? '') !== version) throw new Error('local package manifest and package versions differ')

const marketplace = JSON.parse(readFileSync(resolve(localSourceRoot, 'marketplace.json'), 'utf8'))
const marketplaceName = String(marketplace.name ?? '')
if (!marketplaceName) throw new Error('local plugin source adapter has no name')

const runCodex = commandArgs => spawnSync(codex, commandArgs, { encoding: 'utf8', timeout: 30_000 })
const list = runCodex(['plugin', 'marketplace', 'list'])
if (list.error || list.status !== 0) throw new Error(list.stderr?.trim() || 'cannot inspect configured local plugin sources')
const rows = list.stdout.split(/\r?\n/u).slice(1).map(line => line.trim()).filter(Boolean)
const row = rows.find(line => line.split(/\s+/u)[0] === marketplaceName)
const registeredRoot = row?.slice(marketplaceName.length).trim()

if (registeredRoot && resolve(registeredRoot) !== localSourceRoot) {
  throw new Error(`local plugin source ${marketplaceName} points to a different checkout: ${registeredRoot}`)
}
if (!registeredRoot) {
  const addSource = runCodex(['plugin', 'marketplace', 'add', localSourceRoot, '--json'])
  if (addSource.error || addSource.status !== 0) throw new Error(addSource.stderr?.trim() || 'cannot register local plugin source')
}

const install = runCodex(['plugin', 'add', `${plugin}@${marketplaceName}`, '--json'])
if (install.error || install.status !== 0) throw new Error(install.stderr?.trim() || 'local plugin installation failed')

const installedRoot = resolve(args.get('installed') ?? resolve(codexHome, 'plugins/cache', marketplaceName, plugin, version))
if (!existsSync(installedRoot)) throw new Error(`Codex reported success but the local install is missing: ${installedRoot}`)
const verify = spawnSync(process.execPath, [resolve(scriptDirectory, 'verify-installed-bridge.mjs'), '--source', sourceRoot, '--installed', installedRoot, '--expected-version', version], {
  encoding: 'utf8',
  env: process.env,
  timeout: 20_000,
})
if (verify.status !== 0) throw new Error(verify.stderr?.trim() || 'installed local plugin differs from its source package')

if (process.platform === 'darwin') {
  // Marketplace copies contain the Swift source but not the host-built binary.
  // Build and validate it in the versioned cache before claiming the MCP is
  // usable; the bridge fails during startup when either artifact is absent.
  const helperPath = resolve(installedRoot, 'mcp/keychain-credential-helper')
  const buildInfoPath = resolve(installedRoot, 'mcp/keychain-credential-helper.build.json')
  // Do not accept stale artifacts copied from a prior cache or bundled source.
  rmSync(helperPath, { force: true })
  rmSync(buildInfoPath, { force: true })
  const helperBuild = spawnSync(process.execPath, [resolve(installedRoot, 'scripts/build-keychain-helper.mjs')], {
    encoding: 'utf8', env: process.env, timeout: 120_000,
  })
  if (helperBuild.error || helperBuild.status !== 0) {
    throw new Error(`LOCAL_PLUGIN_KEYCHAIN_BUILD_FAILED: ${helperBuild.stderr?.trim() || helperBuild.error?.message || 'macOS Keychain helper build failed'}`)
  }
  const sourcePath = resolve(installedRoot, 'mcp/keychain-credential-helper.swift')
  try {
    const helper = statSync(helperPath)
    const sourceSha256 = createHash('sha256').update(readFileSync(sourcePath)).digest('hex')
    const binarySha256 = createHash('sha256').update(readFileSync(helperPath)).digest('hex')
    const buildInfo = JSON.parse(readFileSync(buildInfoPath, 'utf8'))
    if (!helper.isFile() || !(helper.mode & 0o111)
      || buildInfo?.schema_version !== '1' || buildInfo.platform !== process.platform || buildInfo.arch !== process.arch
      || buildInfo.source_sha256 !== sourceSha256 || buildInfo.binary_sha256 !== binarySha256) {
      throw new Error('helper or build manifest does not match the installed source/runtime')
    }
  } catch (error) {
    throw new Error(`LOCAL_PLUGIN_KEYCHAIN_HELPER_INVALID: ${error instanceof Error ? error.message : 'missing or invalid build artifacts'}`)
  }
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  mode: 'local_stdio',
  public_marketplace_required: false,
  chatgpt_oauth_required: false,
  plugin,
  version,
  local_source: localSourceRoot,
  installed_root: installedRoot,
  restart_required: true,
}, null, 2)}\n`)
