import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { accessSync, constants, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const KEYCHAIN_SERVICE = 'com.storenova.merchant-mcp'

function fail() {
  throw new Error('MCP_KEYCHAIN_CREDENTIAL_INVALID: credential unavailable, malformed, or bound to a different endpoint/workspace.')
}

function helperFail() {
  throw new Error('MCP_KEYCHAIN_HELPER_INVALID: run scripts/build-keychain-helper.mjs before starting the local plugin.')
}

function sha256(value) { return createHash('sha256').update(value).digest('hex') }

export function assertKeychainHelperReady() {
  const source = fileURLToPath(new URL('./keychain-credential-helper.swift', import.meta.url))
  const binary = fileURLToPath(new URL('./keychain-credential-helper', import.meta.url))
  const manifestPath = fileURLToPath(new URL('./keychain-credential-helper.build.json', import.meta.url))
  try {
    accessSync(binary, constants.X_OK)
    const sourceBytes = readFileSync(source)
    const binaryBytes = readFileSync(binary)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest?.schema_version !== '1' || manifest.platform !== process.platform || manifest.arch !== process.arch
      || manifest.source_sha256 !== sha256(sourceBytes) || manifest.binary_sha256 !== sha256(binaryBytes)) helperFail()
  } catch (error) {
    if (error?.message?.startsWith('MCP_KEYCHAIN_HELPER_INVALID:')) throw error
    helperFail()
  }
  return undefined
}

function binding(apiOrigin, workspaceId) {
  let origin
  try { origin = new URL(apiOrigin).origin }
  catch { fail() }
  const workspace = workspaceId?.trim()
  if (!workspace || origin !== apiOrigin?.trim()) fail()
  return { origin, workspace, account: createHash('sha256').update(`${origin}\n${workspace}`).digest('hex') }
}

function defaultHelper(request) {
  assertKeychainHelperReady()
  const helper = fileURLToPath(new URL('./keychain-credential-helper', import.meta.url))
  const result = spawnSync(helper, [], {
    input: JSON.stringify(request), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 2_000, maxBuffer: 1024 * 1024,
  })
  if (result.error || result.status !== 0) helperFail()
  return result.stdout
}

export function writeKeychainCredential({ apiOrigin, workspaceId }, bundle, options = {}) {
  const { origin, workspace, account } = binding(apiOrigin, workspaceId)
  const access = bundle?.access_token?.trim()
  const refresh = bundle?.refresh_token?.trim()
  const expiry = bundle?.expires_at?.trim()
  if (bundle?.schema_version !== '1' || bundle.api_origin !== origin || bundle.workspace_id !== workspace || !access || !refresh || !expiry || !Number.isFinite(Date.parse(expiry))) fail()
  const record = JSON.stringify({ schema_version: '1', api_origin: origin, workspace_id: workspace, access_token: access, refresh_token: refresh, expires_at: expiry })
  const runHelper = options.runHelper ?? defaultHelper
  try { runHelper({ operation: 'write', service: KEYCHAIN_SERVICE, account, data: record }) }
  catch (error) {
    if (error?.message?.startsWith('MCP_KEYCHAIN_HELPER_INVALID:')) throw error
    fail()
  }
}

export function readKeychainCredential({ apiOrigin, workspaceId }, options = {}) {
  const { origin, workspace, account } = binding(apiOrigin, workspaceId)
  const runHelper = options.runHelper ?? defaultHelper
  let raw
  try { raw = runHelper({ operation: 'read', service: KEYCHAIN_SERVICE, account }) }
  catch (error) {
    if (error?.message?.startsWith('MCP_KEYCHAIN_HELPER_INVALID:')) throw error
    fail()
  }
  let record
  try { record = JSON.parse(String(raw).trim()) }
  catch { fail() }
  if (record?.schema_version !== '1' || record.api_origin !== origin || record.workspace_id !== workspace
    || typeof record.access_token !== 'string' || !record.access_token.trim()
    || typeof record.refresh_token !== 'string' || !record.refresh_token.trim()
    || typeof record.expires_at !== 'string' || !Number.isFinite(Date.parse(record.expires_at))) fail()
  return record
}
