export interface LocalPluginAccount {
  id: string
  login: string
  accountType: string
  status: string
  workspaceIds: string[]
}

export interface LocalPluginCredentialRequest {
  workspaceId: string
  accountLogin: string
  expiresAt: string
  state: 'installer_required'
}

const ERROR_MESSAGES = {
  AUTH_REQUIRED: '登录已失效，请重新登录商家后台后再试。',
  WORKSPACE_BINDING_REQUIRED: '当前账号必须绑定且只能绑定一个工作区，请先检查工作区绑定。',
  ACCESS_DENIED: '当前账号无权申请插件连接，请检查账号权限。',
  UNSAFE_ENDPOINT: '连接地址不安全，请从当前商家后台的同源安全地址重试。',
  INVALID_RESPONSE: '连接响应未通过安全校验，请稍后重试。',
  REQUEST_FAILED: '暂时无法申请插件连接，请稍后重试。',
  ABORTED: '已取消插件连接申请。',
} as const

export type LocalPluginConnectionErrorCode = keyof typeof ERROR_MESSAGES
type SafeStatus = 401 | 403 | 409

export class LocalPluginConnectionError extends Error {
  readonly code: LocalPluginConnectionErrorCode
  readonly status?: SafeStatus

  constructor(code: LocalPluginConnectionErrorCode, status?: SafeStatus) {
    const safeCode = Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code) ? code : 'REQUEST_FAILED'
    super(ERROR_MESSAGES[safeCode])
    this.name = 'LocalPluginConnectionError'
    this.code = safeCode
    this.status = status === 401 || status === 403 || status === 409 ? status : undefined
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value)
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function connectionEndpoint(baseUrl: string): string {
  if (typeof window === 'undefined' || typeof baseUrl !== 'string' || !baseUrl
    || baseUrl.trim() !== baseUrl || /[?#\\\u0000-\u0020\u007f]/u.test(baseUrl)
    || /^https?:\/\/[^/]*@/iu.test(baseUrl)
    || !(/^(?:https?:\/\/|\/(?!\/))/iu.test(baseUrl))) {
    throw new LocalPluginConnectionError('UNSAFE_ENDPOINT')
  }
  try {
    const origin = window.location.origin
    const base = new URL(baseUrl, origin)
    const loopback = base.hostname === 'localhost' || base.hostname === '[::1]'
      || /^127(?:\.\d{1,3}){3}$/u.test(base.hostname)
    if (base.origin !== origin || base.username || base.password || base.search || base.hash
      || !(base.protocol === 'https:' || base.protocol === 'http:' && loopback)) {
      throw new LocalPluginConnectionError('UNSAFE_ENDPOINT')
    }
    return `${base.href.replace(/\/+$/u, '')}/v1/auth/mcp-token`
  } catch {
    throw new LocalPluginConnectionError('UNSAFE_ENDPOINT')
  }
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new LocalPluginConnectionError('ABORTED')
}

/**
 * Ask the current HttpOnly merchant session for a scoped credential, then
 * discard the credential. A browser cannot claim to have installed it in the
 * local plugin or OS keychain; that separate installer step remains required.
 */
export async function requestLocalPluginCredential(
  baseUrl: string,
  account: LocalPluginAccount,
  signal?: AbortSignal,
): Promise<LocalPluginCredentialRequest> {
  assertNotAborted(signal)
  if (!account || !nonEmptyString(account.id) || !nonEmptyString(account.login)
    || account.accountType !== 'merchant' || account.status !== 'active') {
    throw new LocalPluginConnectionError('AUTH_REQUIRED')
  }
  if (!Array.isArray(account.workspaceIds) || account.workspaceIds.length !== 1
    || !nonEmptyString(account.workspaceIds[0]) || account.workspaceIds[0] === '*') {
    throw new LocalPluginConnectionError('WORKSPACE_BINDING_REQUIRED')
  }
  const workspaceId = account.workspaceIds[0]
  const accountLogin = account.login
  const endpoint = connectionEndpoint(baseUrl)
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace_id: workspaceId }),
      signal,
    })
    assertNotAborted(signal)
    // Error bodies are intentionally never read: they may contain credentials
    // or upstream diagnostics that are unsafe to display or retain.
    if (response.status === 401) throw new LocalPluginConnectionError('AUTH_REQUIRED', 401)
    if (response.status === 409) throw new LocalPluginConnectionError('WORKSPACE_BINDING_REQUIRED', 409)
    if (response.status === 403) throw new LocalPluginConnectionError('ACCESS_DENIED', 403)
    if (!response.ok) throw new LocalPluginConnectionError('REQUEST_FAILED')
    const envelope: unknown = await response.json()
    assertNotAborted(signal)
    if (!record(envelope) || envelope.error != null || !record(envelope.data)
      || envelope.workspace_id !== undefined && envelope.workspace_id !== workspaceId) {
      throw new LocalPluginConnectionError('INVALID_RESPONSE')
    }
    const data = envelope.data
    const validToken = (value: unknown) => typeof value === 'string'
      && value.length > 0 && value.length <= 16_384 && /^[\x21-\x7e]+$/u.test(value)
    if (!validToken(data.access_token) || !validToken(data.refresh_token)
      || data.token_type !== 'Bearer' || data.scope !== 'merchant'
      || data.workspace_id !== workspaceId || data.account_login !== accountLogin
      || typeof data.expires_in !== 'number' || !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0) {
      throw new LocalPluginConnectionError('INVALID_RESPONSE')
    }
    const expiry = new Date(Date.now() + data.expires_in * 1_000)
    if (!Number.isFinite(expiry.getTime())) throw new LocalPluginConnectionError('INVALID_RESPONSE')
    return { workspaceId, accountLogin, expiresAt: expiry.toISOString(), state: 'installer_required' }
  } catch (error: unknown) {
    if (signal?.aborted || record(error) && error.name === 'AbortError') {
      throw new LocalPluginConnectionError('ABORTED')
    }
    if (error instanceof LocalPluginConnectionError) throw error
    // Never preserve the original error, cause, response body, or token values.
    throw new LocalPluginConnectionError('REQUEST_FAILED')
  }
}
