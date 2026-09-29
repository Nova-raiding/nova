#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const argumentsByName = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]
  const value = process.argv[index + 1]
  if (!name?.startsWith('--') || !value) throw new Error(`invalid argument: ${name ?? ''}`)
  argumentsByName.set(name.slice(2), value)
}

const configured = name => {
  const value = process.env[name]?.trim()
  return value && !/^\$\{[^}]+\}$/u.test(value) ? value : ''
}
const defaultBindingPath = join(configured('CODEX_HOME') || join(homedir(), '.codex'), 'merchant-marketing', 'workspace-binding.json')
const bindingPath = resolve(argumentsByName.get('binding') ?? defaultBindingPath)
const targetOriginInput = argumentsByName.get('target-origin') ?? configured('MERCHANT_MCP_BASE_URL')
const targetWorkspace = argumentsByName.get('workspace') ?? configured('MERCHANT_WORKSPACE_ID')

function originOf(value) {
  try { return value ? new URL(value).origin : '' } catch { return '' }
}

function isLoopback(origin) {
  try {
    const hostname = new URL(origin).hostname
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
  } catch { return false }
}

let binding
let readError = null
try {
  binding = JSON.parse(readFileSync(bindingPath, 'utf8'))
} catch (error) {
  if (error?.code !== 'ENOENT') readError = 'binding_unreadable_or_invalid'
}

const targetOrigin = originOf(targetOriginInput)
const storedOrigin = originOf(binding?.scope?.api_origin)
const reasons = []
if (readError) reasons.push(readError)
if (binding) {
  if (binding.schema_version !== '2') reasons.push('unsupported_schema')
  if (storedOrigin && targetOrigin && storedOrigin !== targetOrigin) {
    reasons.push(isLoopback(storedOrigin) && targetOrigin === 'https://yxsona.com'
      ? 'loopback_to_production_origin'
      : 'origin_changed')
  }
  if (!binding?.scope?.actor_id || !binding?.scope?.token_sha256) reasons.push('identity_fingerprint_missing')
  if (targetWorkspace && binding.workspace_id && binding.workspace_id !== targetWorkspace) reasons.push('workspace_changed')
}

const stale = reasons.length > 0
const result = {
  binding_present: Boolean(binding),
  stale,
  reusable: Boolean(binding) && !stale,
  reasons,
  stored: binding ? {
    schema_version: binding.schema_version ?? null,
    workspace_id: typeof binding.workspace_id === 'string' ? binding.workspace_id : null,
    api_origin: storedOrigin || null,
    has_actor_fingerprint: Boolean(binding?.scope?.actor_id),
    has_token_fingerprint: Boolean(binding?.scope?.token_sha256),
  } : null,
  target: {
    workspace_id: targetWorkspace || null,
    api_origin: targetOrigin || null,
  },
  action: stale
    ? 'Obtain a new short-lived Store Nova credential for the target workspace, run the installer, then restart the desktop host. The old binding was not reused or deleted.'
    : binding
      ? 'The saved binding metadata matches the requested origin and workspace. Runtime identity validation still applies.'
      : 'No saved binding exists. Complete the normal authenticated installation flow.',
  safety: { old_identity_reused: false, binding_deleted: false, secrets_read: false },
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
