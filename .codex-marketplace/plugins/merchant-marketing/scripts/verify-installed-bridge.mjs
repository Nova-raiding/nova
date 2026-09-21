#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const defaultSourceRoot = resolve(scriptDirectory, '..')
const argumentsByName = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]
  const value = process.argv[index + 1]
  if (!name?.startsWith('--') || !value) throw new Error(`invalid argument: ${name ?? ''}`)
  argumentsByName.set(name.slice(2), value)
}

const sourceRoot = resolve(argumentsByName.get('source') ?? defaultSourceRoot)
const installedRoot = resolve(argumentsByName.get('installed') ?? process.env.MERCHANT_INSTALLED_PLUGIN_DIR ?? '')
if (!argumentsByName.get('installed') && !process.env.MERCHANT_INSTALLED_PLUGIN_DIR) {
  throw new Error('installed plugin path is required via --installed or MERCHANT_INSTALLED_PLUGIN_DIR')
}

const semverPattern = /^\d+\.\d+\.\d+(?:[+-][0-9A-Za-z.-]+)?$/u
const sourceManifest = JSON.parse(readFileSync(resolve(sourceRoot, '.codex-plugin/plugin.json'), 'utf8'))
const sourcePackageJson = JSON.parse(readFileSync(resolve(sourceRoot, 'package.json'), 'utf8'))
const expectedVersion = String(argumentsByName.get('expected-version') ?? sourceManifest.version ?? '')
const sourceManifestVersion = String(sourceManifest.version ?? '')
const sourcePackageVersion = String(sourcePackageJson.version ?? '')
const sourceVersionErrors = [
  semverPattern.test(sourceManifestVersion) ? null : 'source manifest version is missing or invalid',
  sourceManifestVersion === sourcePackageVersion ? null : 'source manifest version does not match source package version',
  expectedVersion === sourceManifestVersion ? null : 'expected version does not match source manifest version',
].filter(Boolean)

const fixedRuntimeFiles = [
  '.codex-plugin/plugin.json',
  '.mcp.json',
  'README.md',
  'package.json',
  'mcp/bridge.sh',
  'mcp/bridge.mjs',
  'mcp/relay-evidence.mjs',
  'mcp/managed-token.mjs',
  'mcp/keychain-credential.mjs',
  'mcp/keychain-credential-helper.swift',
  'scripts/login-local-macos.mjs',
  'scripts/build-keychain-helper.mjs',
  'scheduled/daily-store-risk-scan.json',
  'scheduled/weekly-six-platform-digest.json',
  'ui/image-local-edit.html',
  'ui/recharge.html',
]
const runtimeTreeRoots = ['skills']
const ignoredRuntimeFile = path => /(?:^|\/)(?:[^/]+\.)?(?:test|spec)\.[^/]+$/u.test(path)
const walkRuntimeTree = (root, directory) => {
  const absolute = resolve(root, directory)
  if (!existsSync(absolute)) return []
  return readdirSync(absolute, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(absolute, entry.name)
    if (entry.isDirectory()) return walkRuntimeTree(root, relative(root, path))
    const normalized = relative(root, path).split('\\').join('/')
    return entry.isFile() && !ignoredRuntimeFile(normalized) ? [normalized] : []
  })
}
const sourceRuntimeFiles = [...new Set([
  ...fixedRuntimeFiles,
  ...runtimeTreeRoots.flatMap(directory => walkRuntimeTree(sourceRoot, directory)),
])].sort()
const installedRuntimeFiles = [...new Set([
  ...fixedRuntimeFiles.filter(path => existsSync(resolve(installedRoot, path))),
  ...runtimeTreeRoots.flatMap(directory => walkRuntimeTree(installedRoot, directory)),
])].sort()
const missingRuntimeFiles = sourceRuntimeFiles.filter(path => !existsSync(resolve(installedRoot, path)))
const unexpectedRuntimeFiles = installedRuntimeFiles.filter(path => !sourceRuntimeFiles.includes(path))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const files = sourceRuntimeFiles.filter(path => existsSync(resolve(installedRoot, path))).map(path => {
  const sourceSha256 = sha256(resolve(sourceRoot, path))
  const installedSha256 = sha256(resolve(installedRoot, path))
  return { path, source_sha256: sourceSha256, installed_sha256: installedSha256, matches: sourceSha256 === installedSha256 }
})

const manifest = JSON.parse(readFileSync(resolve(installedRoot, '.codex-plugin/plugin.json'), 'utf8'))
const packageJson = JSON.parse(readFileSync(resolve(installedRoot, 'package.json'), 'utf8'))
const mcp = JSON.parse(readFileSync(resolve(installedRoot, '.mcp.json'), 'utf8'))
const startup = mcp?.mcpServers?.['merchant-marketing']
const manifestErrors = [
  manifest.id === 'merchant-marketing' ? null : 'manifest id is not merchant-marketing',
  manifest.name === 'merchant-marketing' ? null : 'manifest name is not merchant-marketing',
  manifest.version === packageJson.version ? null : 'manifest version does not match package version',
  manifest.version === expectedVersion ? null : 'installed version does not match expected source version',
  manifest.mcpServers === './.mcp.json' ? null : 'manifest mcpServers must point to ./.mcp.json',
  startup?.command === 'sh' ? null : 'MCP startup command must be sh',
  Array.isArray(startup?.args) && startup.args.length === 1 && startup.args[0] === './mcp/bridge.sh' ? null : 'MCP startup args must point to ./mcp/bridge.sh',
].filter(Boolean)
const installedDirectoryVersion = installedRoot.split(/[\\/]/u).at(-1)
const cachePathVersionError = installedDirectoryVersion && semverPattern.test(installedDirectoryVersion) && installedDirectoryVersion !== expectedVersion
  ? `installed cache directory version ${installedDirectoryVersion} does not match expected version ${expectedVersion}`
  : null
if (cachePathVersionError) manifestErrors.push(cachePathVersionError)

const discoveryEnv = { ...process.env, MERCHANT_MCP_TOKEN_SOURCE: 'environment', MERCHANT_MCP_BASE_URL: 'http://127.0.0.1:8790', MERCHANT_WORKSPACE_ID: 'ws_install_verify' }
function discoverTools(root) {
  const bridge = spawnSync(process.execPath, [resolve(root, 'mcp/bridge.mjs')], {
    encoding: 'utf8',
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })}\n`,
    env: discoveryEnv,
    timeout: 10_000,
  })
  if (bridge.status !== 0) return { names: [], error: `exit ${bridge.status ?? 'unknown'}` }
  try {
    const response = JSON.parse(bridge.stdout.trim())
    const tools = Array.isArray(response?.result?.tools) ? response.result.tools : []
    return { names: tools.map(tool => tool?.name).filter(name => typeof name === 'string') }
  } catch {
    return { names: [], error: 'invalid tools/list response' }
  }
}

const sourceDiscovery = discoverTools(sourceRoot)
const installedDiscovery = discoverTools(installedRoot)
const sourceToolNames = sourceDiscovery.names
const toolNames = installedDiscovery.names
const sourceToolSet = new Set(sourceToolNames)
const installedToolSet = new Set(toolNames)
const missingFromInstalled = sourceToolNames.filter(name => !installedToolSet.has(name))
const unexpectedInInstalled = toolNames.filter(name => !sourceToolSet.has(name))
const duplicateTools = toolNames.filter((name, index) => toolNames.indexOf(name) !== index)
const requiredTools = [
  'merchant.start',
  'commercial.access.get',
  'commercial.catalog.get',
  'creative-points.balance.get',
  'creative-points.statement.list',
]
const forbiddenMerchantTools = new Set([
  'billing.reconciliation', 'billing.model-usage.reconciliation.run', 'billing.model-usage.resolve',
  'billing.usage.consume', 'billing.usage.refund', 'billing.refund', 'billing.reconciliation.run',
  'platform.settings.update', 'platform.revoke', 'platform.model.status', 'asset.scan',
  'content.codex.prepare', 'content.codex.commit', 'knowledge.rule.update',
])
const forbiddenTools = toolNames.filter(name => name.startsWith('ops.') || forbiddenMerchantTools.has(name))
const missingTools = requiredTools.filter(name => !toolNames.includes(name))
const mismatchedFiles = files.filter(file => !file.matches).map(file => file.path)
const toolCacheDrift = mismatchedFiles.some(path => path === 'mcp/bridge.mjs' || path === '.mcp.json')
  || missingFromInstalled.length > 0
  || unexpectedInInstalled.length > 0
  || duplicateTools.length > 0
  || Boolean(sourceDiscovery.error)
  || Boolean(installedDiscovery.error)
const ok = mismatchedFiles.length === 0
  && missingRuntimeFiles.length === 0
  && unexpectedRuntimeFiles.length === 0
  && manifestErrors.length === 0
  && sourceVersionErrors.length === 0
  && !sourceDiscovery.error
  && !installedDiscovery.error
  && missingFromInstalled.length === 0
  && unexpectedInInstalled.length === 0
  && duplicateTools.length === 0
  && missingTools.length === 0
  && forbiddenTools.length === 0

const evidence = {
  ok,
  plugin_version: manifest.version,
  expected_plugin_version: expectedVersion,
  source_manifest: { version: sourceManifestVersion, package_version: sourcePackageVersion, errors: sourceVersionErrors },
  manifest: { errors: manifestErrors },
  source_root: sourceRoot,
  installed_root: installedRoot,
  runtime_files: files,
  runtime_inventory: {
    source_count: sourceRuntimeFiles.length,
    installed_count: installedRuntimeFiles.length,
    missing: missingRuntimeFiles,
    unexpected: unexpectedRuntimeFiles,
  },
  tools: {
    count: toolNames.length,
    source_count: sourceToolNames.length,
    source_discovery_error: sourceDiscovery.error ?? null,
    installed_discovery_error: installedDiscovery.error ?? null,
    required: requiredTools,
    missing: missingTools,
    forbidden: forbiddenTools,
    missing_from_installed: missingFromInstalled,
    unexpected_in_installed: unexpectedInInstalled,
    duplicates: duplicateTools,
    cache_drift: {
      detected: toolCacheDrift,
      action: toolCacheDrift
        ? 'Reinstall the plugin from the verified source and fully restart ChatGPT/Codex. Do not reuse an old conversation tool snapshot.'
        : 'No source-versus-installed tool surface drift detected.',
      automatic_reuse: false,
      automatic_deletion: false,
    },
  },
  current_conversation_refresh: {
    verified: false,
    reason: 'The installed bridge can be verified, but an already-running ChatGPT conversation may retain its original tool snapshot.',
  },
}
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
if (!ok) process.exitCode = 1
