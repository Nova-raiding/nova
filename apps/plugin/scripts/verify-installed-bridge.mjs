#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
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

const runtimeFiles = [
  '.codex-plugin/plugin.json',
  '.mcp.json',
  'README.md',
  'package.json',
  'skills/merchant-marketing/SKILL.md',
  'skills/merchant-marketing/references/automations.md',
  'skills/ecommerce-video-marketing/SKILL.md',
  'skills/ecommerce-video-marketing/references/video_templates.md',
  'skills/ecommerce-video-marketing/references/video_guide.md',
  'skills/ecommerce-video-marketing/references/shot_guide.md',
  'skills/ecommerce-video-marketing/references/culture_adaptation.md',
  'skills/storyboard-prompt-assistant/SKILL.md',
  'mcp/bridge.sh',
  'mcp/bridge.mjs',
  'mcp/relay-evidence.mjs',
  'scheduled/daily-store-risk-scan.json',
  'scheduled/weekly-six-platform-digest.json',
  'ui/image-local-edit.html',
  'ui/recharge.html',
]
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const files = runtimeFiles.map(path => {
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
  manifest.mcpServers === './.mcp.json' ? null : 'manifest mcpServers must point to ./.mcp.json',
  startup?.command === 'sh' ? null : 'MCP startup command must be sh',
  Array.isArray(startup?.args) && startup.args.length === 1 && startup.args[0] === './mcp/bridge.sh' ? null : 'MCP startup args must point to ./mcp/bridge.sh',
].filter(Boolean)

const discoveryEnv = { ...process.env, MERCHANT_MCP_BASE_URL: 'http://127.0.0.1:8790', MERCHANT_WORKSPACE_ID: 'ws_install_verify' }
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
  'content.codex.prepare', 'content.codex.commit', 'knowledge.rule.update', 'billing.recharge.create',
])
const forbiddenTools = toolNames.filter(name => name.startsWith('ops.') || forbiddenMerchantTools.has(name))
const missingTools = requiredTools.filter(name => !toolNames.includes(name))
const mismatchedFiles = files.filter(file => !file.matches).map(file => file.path)
const ok = mismatchedFiles.length === 0
  && manifestErrors.length === 0
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
  manifest: { errors: manifestErrors },
  source_root: sourceRoot,
  installed_root: installedRoot,
  runtime_files: files,
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
  },
  current_conversation_refresh: {
    verified: false,
    reason: 'The installed bridge can be verified, but an already-running ChatGPT conversation may retain its original tool snapshot.',
  },
}
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
if (!ok) process.exitCode = 1
