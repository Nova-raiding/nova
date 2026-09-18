#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const defaultSourceRoot = resolve(scriptDirectory, '..')
const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]
  const value = process.argv[index + 1]
  if (!name?.startsWith('--') || !value) throw new Error(`invalid argument: ${name ?? ''}`)
  args.set(name.slice(2), value)
}

const sourceRoot = resolve(args.get('source') ?? defaultSourceRoot)
const marketplace = args.get('marketplace') ?? 'merchant-local'
const plugin = args.get('plugin') ?? 'merchant-marketing'
const codex = args.get('codex') ?? 'codex'
const codexHome = resolve(args.get('codex-home') ?? process.env.CODEX_HOME ?? resolve(process.env.HOME ?? '', '.codex'))
const manifest = JSON.parse(readFileSync(resolve(sourceRoot, '.codex-plugin/plugin.json'), 'utf8'))
const packageJson = JSON.parse(readFileSync(resolve(sourceRoot, 'package.json'), 'utf8'))
const version = String(manifest.version ?? '')
if (!/^\d+\.\d+\.\d+(?:[+-][0-9A-Za-z.-]+)?$/u.test(version)) throw new Error('source plugin version is missing or invalid')
if (String(packageJson.version ?? '') !== version) throw new Error('source plugin manifest and package versions differ; refusing to install an ambiguous build')

const installedRoot = resolve(args.get('installed') ?? resolve(codexHome, 'plugins/cache', marketplace, plugin, version))
const selector = `${plugin}@${marketplace}`
const install = spawnSync(codex, ['plugin', 'add', selector, '--json'], { encoding: 'utf8', timeout: 30_000 })
if (install.error || install.status !== 0) {
  process.stderr.write(install.stderr || `Codex plugin upgrade failed with exit ${install.status ?? 'unknown'}\n`)
  process.exit(1)
}
if (!existsSync(installedRoot)) {
  process.stderr.write(`Codex reported success but the versioned install is missing: ${installedRoot}\n`)
  process.exit(1)
}

const verify = spawnSync(process.execPath, [resolve(scriptDirectory, 'verify-installed-bridge.mjs'), '--source', sourceRoot, '--installed', installedRoot, '--expected-version', version], {
  encoding: 'utf8',
  env: process.env,
  timeout: 15_000,
})
if (verify.stdout) process.stdout.write(verify.stdout)
if (verify.status !== 0) {
  if (verify.stderr) process.stderr.write(verify.stderr)
  process.stderr.write('Installed plugin differs from the source package; keep the current host session closed and do not use this install.\n')
  process.exit(1)
}
process.stderr.write(`Verified ${selector} ${version}. Fully restart ChatGPT/Codex and open a new conversation.\n`)
