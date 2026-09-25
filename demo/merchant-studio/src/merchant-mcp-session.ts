type MerchantMcpCredential = {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

type MerchantMcpCredentialResponse = {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
}

/** Keeps the browser's short-lived MCP bearer separate from its login session. */
export class MerchantMcpSession {
  private credential?: MerchantMcpCredential
  private pending?: Promise<MerchantMcpCredential>
  private generation = 0

  constructor(private readonly now: () => number = Date.now) {}

  clear() {
    this.generation += 1
    this.credential = undefined
    this.pending = undefined
  }

  async request<T>(
    issue: () => Promise<MerchantMcpCredentialResponse>,
    invoke: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    const credential = await this.getCredential(issue)
    try {
      return await invoke(credential.accessToken)
    } catch (error) {
      if ((error as { status?: unknown } | undefined)?.status !== 401) throw error
      if (this.credential?.accessToken === credential.accessToken) this.credential = undefined
      const renewed = await this.getCredential(issue)
      return invoke(renewed.accessToken)
    }
  }

  async revoke(revokeToken: (refreshToken: string) => Promise<unknown>): Promise<void> {
    const refreshToken = this.credential?.refreshToken
    this.clear()
    if (refreshToken) await revokeToken(refreshToken).catch(() => undefined)
  }

  private async getCredential(issue: () => Promise<MerchantMcpCredentialResponse>): Promise<MerchantMcpCredential> {
    if (this.credential && this.credential.expiresAt > this.now() + 30_000) return this.credential
    if (!this.pending) {
      const generation = this.generation
      const pending = issue().then(response => {
        const accessToken = typeof response.access_token === 'string' ? response.access_token.trim() : ''
        const refreshToken = typeof response.refresh_token === 'string' ? response.refresh_token.trim() : ''
        const expiresIn = typeof response.expires_in === 'number' && Number.isFinite(response.expires_in) ? response.expires_in : 0
        if (!accessToken || !refreshToken || expiresIn <= 0) throw new Error('商家 MCP 连接凭据响应无效')
        const credential = { accessToken, refreshToken, expiresAt: this.now() + expiresIn * 1_000 }
        if (generation === this.generation) this.credential = credential
        return credential
      }).finally(() => {
        if (this.pending === pending) this.pending = undefined
      })
      this.pending = pending
    }
    return this.pending
  }
}
