export function loadManagedToken(env, platform, readLaunchd) {
  const source = env.MERCHANT_MCP_TOKEN_SOURCE?.trim() || 'environment'
  if (source === 'environment') return
  const reject = () => {
    delete env.MERCHANT_MCP_TOKEN
    delete env.MERCHANT_MCP_REFRESH_TOKEN
    throw new Error('MCP_CREDENTIAL_SOURCE_INVALID: managed credentials unavailable or scope changed; reconnect with matching configuration.')
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
