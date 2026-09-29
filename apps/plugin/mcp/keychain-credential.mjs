import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { accessSync, constants, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const KEYCHAIN_SERVICE = 'com.storenova.merchant-mcp'
const INSTALLATION_ACCOUNT_PREFIX = 'store-nova-installation-identity\n'

function fail() {
  throw new Error('MCP_KEYCHAIN_CREDENTIAL_INVALID: credential unavailable, malformed, or bound to a different endpoint/workspace.')
}

function helperFail(reason) {
  throw new Error(`MCP_KEYCHAIN_HELPER_INVALID: ${reason ?? 'helper unavailable or build manifest invalid'}`)
}

export function keychainHelperFailureReason(result, operation) {
  const safeOperation = ['read', 'read_optional', 'write'].includes(operation) ? operation : 'unknown'
  if (result?.error?.code === 'ETIMEDOUT') return `helper_timeout operation=${safeOperation}`
  const stderr = typeof result?.stderr === 'string' ? result.stderr : ''
  const statusMatch = stderr.match(/^keychain_osstatus=(-?\d+) operation=(read|read_optional|write)\n?$/u)
  if (statusMatch && statusMatch[2] === safeOperation) return `keychain_osstatus=${statusMatch[1]} operation=${safeOperation}`
  if (result?.error) return `helper_start_failed operation=${safeOperation}`
  return `helper_exit=${Number.isInteger(result?.status) ? result.status : 'unknown'}`
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

export function isQaBrokerPackage() {
  try {
    const profile = JSON.parse(readFileSync(fileURLToPath(new URL('../bundle-profile.json', import.meta.url)), 'utf8'))
    return profile?.schema_version === '1' && profile.profile === 'qa-broker' && profile.qa_only === true
      && profile.release_eligible === false && profile.credential_broker?.included === true
      && profile.credential_broker?.authenticated_peer_identity === false
      && profile.credential_broker?.release_eligible === false
  } catch { return false }
}

export function keychainCredentialSeed({ apiOrigin, workspaceId }, bundle) {
  const { origin, workspace, account } = binding(apiOrigin, workspaceId)
  const access = bundle?.access_token?.trim()
  const refresh = bundle?.refresh_token?.trim()
  const expiry = bundle?.expires_at?.trim()
  if (bundle?.schema_version !== '1' || bundle.api_origin !== origin || bundle.workspace_id !== workspace
    || !access || !refresh || !expiry || !Number.isFinite(Date.parse(expiry))) fail()
  return { account, data: JSON.stringify({ schema_version: '1', api_origin: origin, workspace_id: workspace,
    access_token: access, refresh_token: refresh, expires_at: expiry }) }
}

function defaultHelper(request, spawn = spawnSync) {
  const qaBroker = isQaBrokerPackage()
  if (!qaBroker) assertKeychainHelperReady()
  // QA packages use the explicitly release-ineligible seeded broker. A signed
  // production package invokes the native helper directly; the helper checks
  // the live process ancestry and designated signatures before touching the
  // Keychain, accepting only ChatGPT or Store Nova Connect from its own team.
  const executable = qaBroker
    ? process.execPath
    : fileURLToPath(new URL('./keychain-credential-helper', import.meta.url))
  const arguments_ = qaBroker
    ? [fileURLToPath(new URL('./keychain-broker.mjs', import.meta.url)), '--client']
    : []
  const result = spawn(executable, arguments_, {
    input: JSON.stringify(request), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    timeout: request.operation === 'write' ? 125_000 : 10_000, maxBuffer: 1024 * 1024,
  })
  if (result.error || result.status !== 0) {
    helperFail(qaBroker
      ? result.error?.code === 'ETIMEDOUT' ? 'broker_timeout' : 'broker_unavailable'
      : keychainHelperFailureReason(result, request.operation))
  }
  return result.stdout
}

export function writeKeychainCredential({ apiOrigin, workspaceId }, bundle, options = {}) {
  const { origin, workspace, account } = binding(apiOrigin, workspaceId)
  const access = bundle?.access_token?.trim()
  const refresh = bundle?.refresh_token?.trim()
  const expiry = bundle?.expires_at?.trim()
  if (bundle?.schema_version !== '1' || bundle.api_origin !== origin || bundle.workspace_id !== workspace
    || !access || !refresh || !expiry || !Number.isFinite(Date.parse(expiry))) fail()
  const record = JSON.stringify({ schema_version: '1', api_origin: origin, workspace_id: workspace,
    access_token: access, refresh_token: refresh, expires_at: expiry })
  const runHelper = options.runHelper ?? (request => defaultHelper(request, options.spawnHelper))
  try { runHelper({ operation: 'write', service: KEYCHAIN_SERVICE, account, data: record }) }
  catch (error) {
    if (error?.message?.startsWith('MCP_KEYCHAIN_HELPER_INVALID:')) throw error
    fail()
  }
}

export function readKeychainCredential({ apiOrigin, workspaceId }, options = {}) {
  const { origin, workspace, account } = binding(apiOrigin, workspaceId)
  const runHelper = options.runHelper ?? (request => defaultHelper(request, options.spawnHelper))
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

/** Keep the installation signing key in Keychain, scoped to the API origin. */
export function installationIdentityStore(apiOrigin, owner, options = {}) {
  const { origin } = binding(apiOrigin, 'installation')
  if (!owner || !/^[A-Za-z0-9_-]{1,128}$/u.test(owner.accountId ?? '')
    || !/^(?:ws_|workspace_)[A-Za-z0-9_-]{1,120}$/u.test(owner.workspaceId ?? '')) fail()
  const account = sha256(`${INSTALLATION_ACCOUNT_PREFIX}${origin}\n${owner.accountId}\n${owner.workspaceId}`)
  const runHelper = options.runHelper ?? (request => defaultHelper(request, options.spawnHelper))
  return {
    load() {
      const raw = String(runHelper({ operation: 'read_optional', service: KEYCHAIN_SERVICE, account })).trim()
      const parsed = JSON.parse(raw)
      return parsed === null ? undefined : parsed
    },
    save(identity) {
      runHelper({ operation: 'write', service: KEYCHAIN_SERVICE, account, data: JSON.stringify(identity) })
    },
  }
}
