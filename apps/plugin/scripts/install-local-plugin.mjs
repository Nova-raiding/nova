#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
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
