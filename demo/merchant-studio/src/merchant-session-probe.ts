export type MerchantSessionProbeFailure = {
  state: 'signed_out' | 'error'
  message: string
  retryable: boolean
}

/** Distinguish an ordinary missing/expired cookie from a failed session read. */
export function merchantSessionProbeFailure(
  error: unknown,
  describe: (error: unknown) => string,
): MerchantSessionProbeFailure {
  const details = error as { code?: unknown; status?: unknown } | null
  const code = typeof details?.code === 'string' ? details.code : ''
  const status = typeof details?.status === 'number' ? details.status : undefined
  const message = error instanceof Error ? error.message : ''
  if (code === 'AUTH_MERCHANT_ACCOUNT_REQUIRED' || code === 'API_AUTH_TOKEN_MISSING' || code === 'API_WORKSPACE_ID_MISSING') {
    return { state: 'error', message: describe(error), retryable: false }
  }
  const normalizedAuthFailure = `${code} ${message}`.toLowerCase()
  const expiredSession = /(?:session|token|登录|会话|credential|身份|auth).*(?:expired|invalid|required|失效|无效|缺失|过期)/i.test(normalizedAuthFailure)
  if (status === 401 || status === 403 && expiredSession || ['AUTH_SESSION_INVALID', 'AUTH_SESSION_EXPIRED', 'SESSION_EXPIRED'].includes(code)) {
    return { state: 'signed_out', message: '', retryable: false }
  }
  if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
    return { state: 'error', message: describe(error), retryable: false }
  }
  return {
    state: 'error',
    message: `无法验证登录状态：${describe(error)}`,
    retryable: true,
  }
}
