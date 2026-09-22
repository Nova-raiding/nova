#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(pluginRoot, '..', '..')
const manifest = JSON.parse(readFileSync(resolve(pluginRoot, '.codex-plugin/plugin.json'), 'utf8'))
const packageJson = JSON.parse(readFileSync(resolve(pluginRoot, 'package.json'), 'utf8'))
const version = String(manifest.version ?? '')
if (!version || version !== String(packageJson.version ?? '')) {
  throw new Error('plugin manifest and package versions must match before packaging')
}

const output = resolve(process.argv[2] ?? resolve(repositoryRoot, 'artifacts', 'local-plugin', `${manifest.id}-${version}.tar.gz`))
const required = [
  '.codex-plugin/plugin.json', '.mcp.json', 'package.json', 'README.md',
  'mcp/bridge.mjs', 'mcp/bridge.sh', 'mcp/keychain-credential.mjs', 'mcp/keychain-credential-helper.swift',
  'mcp/managed-token.mjs', 'mcp/relay-evidence.mjs',
  'scripts/build-keychain-helper.mjs', 'scripts/diagnose-workspace-binding.mjs', 'scripts/install-local-macos.sh',
  'scripts/install-local-plugin.mjs', 'scripts/login-local-macos.mjs', 'scripts/upgrade-installed-plugin.mjs',
  'scripts/verify-installed-bridge.mjs', 'scripts/verify-marketplace-source.mjs',
  'scheduled/daily-store-risk-scan.json', 'scheduled/weekly-six-platform-digest.json',
  'skills/ecommerce-video-marketing/SKILL.md', 'skills/merchant-marketing/SKILL.md',
  'skills/six-platform-public-import/SKILL.md', 'skills/storyboard-prompt-assistant/SKILL.md',
  'ui/image-local-edit.html', 'ui/recharge.html',
]
for (const relativePath of required) {
  if (!existsSync(resolve(pluginRoot, relativePath))) throw new Error(`local plugin input is missing: ${relativePath}`)
}

const staging = mkdtempSync(resolve(repositoryRoot, '.local-plugin-package-'))
try {
  for (const relativePath of required) {
    const destination = resolve(staging, relativePath)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(resolve(pluginRoot, relativePath), destination, { recursive: true })
  }
  mkdirSync(dirname(output), { recursive: true })
  const result = spawnSync('tar', ['-czf', output, '-C', staging, ...required], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr?.trim() || 'tar failed while creating local plugin package')
  process.stdout.write(`${JSON.stringify({ ok: true, artifact: output, plugin: manifest.id, version, cloud_code_included: false }, null, 2)}\n`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
