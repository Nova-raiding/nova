import { createHash } from 'node:crypto'
import { mkdir, lstat, open, rmdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readKeychainCredential } from './keychain-credential.mjs'
import { readWindowsCredential } from './windows-credential.mjs'
import { TEMPORARY_CREDENTIAL_ERROR_CODE } from './managed-credential-state.mjs'

function managedStoreReadFailure(error, env) {
  // Preserve only a safe retry classification. Raw credential-store and IPC
  // diagnostics must never cross the MCP boundary.
  const classification = String(error?.code ?? error?.message ?? '')
  // QA broker packages wrap client startup/timeout failures at the Keychain
  // helper boundary. Production's authenticated IPC gate uses a different
  // reason and deliberately remains a permanent, fail-closed configuration
  // error; recognizing these narrow reasons does not enable the QA broker.
  if (/^(?:KEYCHAIN_BROKER_(?:UNAVAILABLE|TIMEOUT)|MCP_KEYCHAIN_HELPER_INVALID: broker_(?:unavailable|timeout))$/u.test(classification)) {
    delete env.MERCHANT_MCP_TOKEN
    delete env.MERCHANT_MCP_REFRESH_TOKEN
    delete env.MERCHANT_MCP_TOKEN_EXPIRES_AT
    const transient = new Error('MCP_CREDENTIAL_SOURCE_INVALID: managed credential service temporarily unavailable.')
    transient.code = TEMPORARY_CREDENTIAL_ERROR_CODE
    throw transient
  }
}

export function validatedRotatedCredential(result, { tokenSource, workspaceId, apiOrigin, now = Date.now() }) {
  const accessToken = typeof result?.access_token === 'string' ? result.access_token.trim() : ''
  const refreshToken = typeof result?.refresh_token === 'string' ? result.refresh_token.trim() : ''
  if (!accessToken || !refreshToken || !workspaceId || !apiOrigin) return null
  const hasWorkspace = result?.workspace_id !== undefined
  const hasType = result?.token_type !== undefined
  const hasScope = result?.scope !== undefined
  const hasExpiry = result?.expires_in !== undefined
  const tokenType = typeof result?.token_type === 'string' ? result.token_type.trim().toLowerCase() : ''
  const scopes = typeof result?.scope === 'string' ? result.scope.trim().split(/\s+/u) : []
  const expiresIn = Number(result?.expires_in)
  if ((hasWorkspace && result.workspace_id !== workspaceId) || (hasType && tokenType !== 'bearer')
    || (hasScope && !scopes.includes('merchant'))
    || (hasExpiry && (!Number.isSafeInteger(expiresIn) || expiresIn <= 0 || expiresIn > 86_400))) return null
  if (['keychain', 'windows_credential_manager'].includes(tokenSource) && (!hasWorkspace || !hasType || !hasScope || !hasExpiry)) return null
  const expiresAt = hasExpiry ? new Date(now + expiresIn * 1000).toISOString() : ''
  return { accessToken, refreshToken, expiresAt, bundle: { schema_version: '1', api_origin: apiOrigin, workspace_id: workspaceId, access_token: accessToken, refresh_token: refreshToken, expires_at: expiresAt } }
}

export function loadManagedToken(env, platform, readLaunchd, readKeychain = readKeychainCredential, readWindows = readWindowsCredential) {
  const source = env.MERCHANT_MCP_TOKEN_SOURCE?.trim() || 'environment'
  if (source === 'environment') return
  const reject = () => {
    delete env.MERCHANT_MCP_TOKEN
    delete env.MERCHANT_MCP_REFRESH_TOKEN
    delete env.MERCHANT_MCP_TOKEN_EXPIRES_AT
    throw new Error('MCP_CREDENTIAL_SOURCE_INVALID: managed credentials unavailable or scope changed; reconnect with matching configuration.')
  }
  if (source === 'keychain' || source === 'windows_credential_manager') {
    if ((source === 'keychain' ? platform !== 'darwin' : platform !== 'win32')
      || env.MERCHANT_ACTOR_ID?.trim() || env.MERCHANT_MCP_ROLE?.trim()) reject()
    let origin
    try { origin = new URL(env.MERCHANT_MCP_BASE_URL?.trim()).origin } catch { reject() }
    const workspaceId = env.MERCHANT_WORKSPACE_ID?.trim()
    if (!workspaceId) reject()
    let recordOrPromise
    try { recordOrPromise = (source === 'keychain' ? readKeychain : readWindows)({ apiOrigin: origin, workspaceId }) }
    catch (error) { managedStoreReadFailure(error, env); reject() }
    return Promise.resolve(recordOrPromise).then(record => {
      if (!record?.access_token || !record?.refresh_token) reject()
      env.MERCHANT_MCP_TOKEN = record.access_token
      env.MERCHANT_MCP_REFRESH_TOKEN = record.refresh_token
      env.MERCHANT_MCP_TOKEN_EXPIRES_AT = record.expires_at ?? ''
    }, error => { managedStoreReadFailure(error, env); reject() })
  }
  if (source !== 'launchd' || platform !== 'darwin') reject()
  let values
  try {
    values = Object.fromEntries(['MERCHANT_MCP_BASE_URL', 'MERCHANT_WORKSPACE_ID', 'MERCHANT_MCP_TOKEN', 'MERCHANT_MCP_REFRESH_TOKEN'].map(name => [name, readLaunchd(name).trim()]))
  } catch { reject() }
  // Exact matching prevents cross-tenant or endpoint credential substitution.
  if (!values.MERCHANT_MCP_TOKEN || /^\$\{[^}]+\}$/u.test(values.MERCHANT_MCP_TOKEN)
    || !values.MERCHANT_MCP_REFRESH_TOKEN || /^\$\{[^}]+\}$/u.test(values.MERCHANT_MCP_REFRESH_TOKEN)
    || !values.MERCHANT_MCP_BASE_URL || !values.MERCHANT_WORKSPACE_ID
    || env.MERCHANT_MCP_BASE_URL?.trim() !== values.MERCHANT_MCP_BASE_URL
    || env.MERCHANT_WORKSPACE_ID?.trim() !== values.MERCHANT_WORKSPACE_ID) reject()
  // Opaque managed tokens cannot be verified against an explicit actor pin.
  if (env.MERCHANT_ACTOR_ID?.trim() || env.MERCHANT_MCP_ROLE?.trim()) reject()
  env.MERCHANT_MCP_TOKEN = values.MERCHANT_MCP_TOKEN
  env.MERCHANT_MCP_REFRESH_TOKEN = values.MERCHANT_MCP_REFRESH_TOKEN
}

// Shared across plugin versions and bridge processes. A dispatched refresh is
// single-use even if its response or the subsequent credential write is lost.
export async function withManagedRefreshLock({ origin, workspaceId, source, root = join(homedir(), '.codex', 'merchant-marketing', 'credential-refresh'), timeoutMs = 20000 }, operation) {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077)))) throw new Error('MCP_REFRESH_LOCK_UNSAFE')
  const scope = createHash('sha256').update(JSON.stringify([origin, workspaceId, source])).digest('hex')
  const lock = join(root, `${scope}.lock`)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      // Never steal a lock by age: a crashed owner may have dispatched a
      // single-use refresh. Recovery must inspect the durable dispatch record.
      if (Date.now() >= deadline) throw new Error('MCP_REFRESH_LOCK_BUSY')
      await new Promise(resolve => setTimeout(resolve, 40))
    }
  }
  try {
    return await operation(async refreshToken => {
      const fingerprint = createHash('sha256').update(refreshToken).digest('hex')
      const record = await open(join(root, `${scope}.${fingerprint}.dispatched`), 'wx', 0o600)
      try { await record.writeFile('single-use refresh dispatched\n'); await record.sync() } finally { await record.close() }
    })
  } finally { await rmdir(lock) }
}
