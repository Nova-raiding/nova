import { readKeychainCredential } from './keychain-credential.mjs'

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
  if (tokenSource === 'keychain' && (!hasWorkspace || !hasType || !hasScope || !hasExpiry)) return null
  const expiresAt = hasExpiry ? new Date(now + expiresIn * 1000).toISOString() : ''
  return { accessToken, refreshToken, expiresAt, bundle: { schema_version: '1', api_origin: apiOrigin, workspace_id: workspaceId, access_token: accessToken, refresh_token: refreshToken, expires_at: expiresAt } }
}

export function loadManagedToken(env, platform, readLaunchd, readKeychain = readKeychainCredential) {
  const source = env.MERCHANT_MCP_TOKEN_SOURCE?.trim() || 'environment'
  if (source === 'environment') return
  const reject = () => {
    delete env.MERCHANT_MCP_TOKEN
    delete env.MERCHANT_MCP_REFRESH_TOKEN
    throw new Error('MCP_CREDENTIAL_SOURCE_INVALID: managed credentials unavailable or scope changed; reconnect with matching configuration.')
  }
  if (source === 'keychain') {
    if (platform !== 'darwin' || env.MERCHANT_ACTOR_ID?.trim() || env.MERCHANT_MCP_ROLE?.trim()) reject()
    let origin
    try { origin = new URL(env.MERCHANT_MCP_BASE_URL?.trim()).origin } catch { reject() }
    const workspaceId = env.MERCHANT_WORKSPACE_ID?.trim()
    if (!workspaceId) reject()
    let recordOrPromise
    try { recordOrPromise = readKeychain({ apiOrigin: origin, workspaceId }) }
    catch { reject() }
    return Promise.resolve(recordOrPromise).then(record => {
      if (!record?.access_token || !record?.refresh_token) reject()
      env.MERCHANT_MCP_TOKEN = record.access_token
      env.MERCHANT_MCP_REFRESH_TOKEN = record.refresh_token
      env.MERCHANT_MCP_TOKEN_EXPIRES_AT = record.expires_at ?? ''
    }, reject)
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
