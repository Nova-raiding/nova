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
  'package.json',
  'skills/merchant-marketing/SKILL.md',
  'mcp/bridge.sh',
  'mcp/bridge.mjs',
  'mcp/relay-evidence.mjs',
  'ui/recharge.html',
]
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const files = runtimeFiles.map(path => {
  const sourceSha256 = sha256(resolve(sourceRoot, path))
  const installedSha256 = sha256(resolve(installedRoot, path))
  return { path, source_sha256: sourceSha256, installed_sha256: installedSha256, matches: sourceSha256 === installedSha256 }
})

const manifest = JSON.parse(readFileSync(resolve(installedRoot, '.codex-plugin/plugin.json'), 'utf8'))
const bridge = spawnSync(process.execPath, [resolve(installedRoot, 'mcp/bridge.mjs')], {
  encoding: 'utf8',
  input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })}\n`,
  env: { ...process.env, MERCHANT_MCP_BASE_URL: 'http://127.0.0.1:8790', MERCHANT_WORKSPACE_ID: 'ws_install_verify' },
  timeout: 10_000,
})
if (bridge.status !== 0) throw new Error(`installed bridge failed: ${bridge.stderr.trim() || `exit ${bridge.status}`}`)
const response = JSON.parse(bridge.stdout.trim())
const tools = Array.isArray(response?.result?.tools) ? response.result.tools : []
const toolNames = tools.map(tool => tool?.name).filter(name => typeof name === 'string')
const requiredTools = [
  'merchant.start',
  'commercial.access.get',
  'commercial.catalog.get',
  'creative-points.balance.get',
  'creative-points.statement.list',
]
const forbiddenTools = toolNames.filter(name => name.startsWith('ops.') || name === 'billing.recharge.create')
const missingTools = requiredTools.filter(name => !toolNames.includes(name))
const mismatchedFiles = files.filter(file => !file.matches).map(file => file.path)
const ok = mismatchedFiles.length === 0 && missingTools.length === 0 && forbiddenTools.length === 0

const evidence = {
  ok,
  plugin_version: manifest.version,
  source_root: sourceRoot,
  installed_root: installedRoot,
  runtime_files: files,
  tools: {
    count: toolNames.length,
    required: requiredTools,
    missing: missingTools,
    forbidden: forbiddenTools,
  },
  current_conversation_refresh: {
    verified: false,
    reason: 'The installed bridge can be verified, but an already-running ChatGPT conversation may retain its original tool snapshot.',
  },
}
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
if (!ok) process.exitCode = 1
