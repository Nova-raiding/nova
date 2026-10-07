/** Only the local plugin consent endpoint may be used as a post-login target. */
export function pluginAuthorizationReturnPath(search: string): string | null {
  const values = new URLSearchParams(search).getAll('plugin_authorize')
  if (values.length !== 1) return null
  const value = values[0] ?? ''
  if (!value.startsWith('/v1/auth/local-plugin/authorize?') || value.includes('#') || value.includes('\\')) return null
  try {
    const url = new URL(value, 'https://merchant.invalid')
    if (url.origin !== 'https://merchant.invalid' || url.pathname !== '/v1/auth/local-plugin/authorize') return null
    const params = url.searchParams
    if (params.get('client_id') !== 'local-desktop' || params.get('response_type') !== 'code' || !params.get('state')) return null
    return `${url.pathname}${url.search}`
  } catch {
    return null
  }
}

/**
 * Redirect only after the merchant session has been established. Keeping the
 * decision here makes the login-submit and login-retry paths use the same
 * fail-closed return-target validation.
 */
export function redirectToPluginAuthorization(
  search: string,
  assign: (path: string) => void,
): boolean {
  const path = pluginAuthorizationReturnPath(search)
  if (!path) return false
  assign(path)
  return true
}
