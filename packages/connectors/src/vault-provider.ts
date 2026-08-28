import { createHash } from 'node:crypto'
import type { AccessCredential, CredentialProvider, CredentialRef, VaultCredentialProvider } from './types.js'
import { inspectOutboundUrl } from './outbound-security.js'

export interface VaultFetchLike {
  (input: string | URL, init?: RequestInit): Promise<Response>
}

export interface VaultCredentialProviderOptions {
  address: string
  token: string
  mount?: string
  namespace?: string
  pathPrefix?: string
  timeoutMs?: number
  fetch?: VaultFetchLike
}

type VaultPayload = { data?: Record<string, unknown> }
const DEFAULT_VAULT_TIMEOUT_MS = 10_000
const MAX_VAULT_RESPONSE_BYTES = 1 * 1024 * 1024

function cleanAddress(address: string) { return address.replace(/\/$/, '') }
function cleanPart(value: string) { return value.replace(/^\/+|\/+$/g, '') }
function isUnsafePathPart(value: string): boolean {
  const part = cleanPart(value)
  if (part === '.' || part === '..') return true
  try { return decodeURIComponent(part) === '.' || decodeURIComponent(part) === '..' } catch { return true }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function stringValue(value: unknown) { return typeof value === 'string' && value.length > 0 ? value : undefined }

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error('Vault response exceeded safety limit')
  if (!response.body) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('Vault response exceeded safety limit')
    return text
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error('Vault response exceeded safety limit')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
}

function credentialFromVault(value: Record<string, unknown>): AccessCredential | undefined {
  const accessToken = stringValue(value.access_token)
  if (!accessToken) return undefined
  return {
    accessToken,
    ...(stringValue(value.token_type) ? { tokenType: stringValue(value.token_type) } : {}),
    ...(stringValue(value.refresh_token) ? { refreshToken: stringValue(value.refresh_token) } : {}),
    ...(stringValue(value.expires_at) ? { expiresAt: stringValue(value.expires_at) } : {}),
    ...(stringValue(value.scope) ? { scope: stringValue(value.scope) } : {}),
  }
}

/**
 * HashiCorp Vault KV v2 adapter. Credential refs are opaque `vault://...`
 * paths; access and refresh tokens never leave this provider boundary.
 */
export class VaultKvCredentialProvider implements VaultCredentialProvider {
  readonly kind = 'vault' as const
  private readonly fetchImpl: VaultFetchLike
  private readonly address: string
  private readonly mount: string
  private readonly namespace?: string
  private readonly pathPrefix: string

  constructor(private readonly options: VaultCredentialProviderOptions) {
    if (!options.address || !options.token) throw new Error('Vault address and token are required')
    try {
      const protocol = new URL(options.address).protocol
      if (protocol !== 'https:' && process.env.NODE_ENV !== 'test') throw new Error('Vault address must use HTTPS outside tests')
    } catch (error) {
      if (error instanceof Error && error.message.includes('must use HTTPS')) throw error
      throw new Error('Vault address must be a valid URL')
    }
    const outboundError = inspectOutboundUrl(options.address, { environment: process.env.NODE_ENV, resolveDns: false })
    if (outboundError) throw new Error(`unsafe Vault address: ${outboundError}`)
    this.address = cleanAddress(options.address)
    this.mount = cleanPart(options.mount ?? 'secret')
    this.namespace = options.namespace?.trim() || undefined
    this.pathPrefix = cleanPart(options.pathPrefix ?? 'merchant-marketing')
    this.fetchImpl = options.fetch ?? fetch
  }

  async resolve(ref: CredentialRef | { accountId: string; credentialRef?: string }): Promise<AccessCredential | undefined> {
    const path = this.pathFrom(ref)
    const response = await this.request('GET', `/v1/${this.mount}/data/${path}`)
    if (response.status === 404) return undefined
    const payload = await this.json(response)
    const data = isRecord(payload) && isRecord(payload.data) && isRecord(payload.data.data) ? payload.data.data : undefined
    return data ? credentialFromVault(data) : undefined
  }

  async store(input: { workspaceId?: string; accountId: string; credential: AccessCredential }): Promise<CredentialRef> {
    const path = input.workspaceId
      ? `${this.pathPrefix}/workspaces/${createHash('sha256').update(input.workspaceId).digest('hex').slice(0, 24)}/accounts/${createHash('sha256').update(input.accountId).digest('hex').slice(0, 24)}`
      : this.pathFrom({ accountId: input.accountId })
    const response = await this.request('POST', `/v1/${this.mount}/data/${path}`, { data: input.credential })
    if (!response.ok) throw new Error('Vault credential write failed')
    return {
      accountId: input.accountId,
      credentialRef: `vault://${this.mount}/${path}`,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.credential.expiresAt ? { expiresAt: input.credential.expiresAt } : {}),
      ...(input.credential.scope ? { scope: input.credential.scope } : {}),
      refreshable: Boolean(input.credential.refreshToken),
    }
  }

  async revoke(ref: CredentialRef): Promise<void> {
    const path = this.pathFrom(ref)
    const response = await this.request('DELETE', `/v1/${this.mount}/metadata/${path}`)
    if (!response.ok && response.status !== 404) throw new Error('Vault credential revoke failed')
  }

  private pathFrom(ref: { accountId: string; credentialRef?: string }): string {
    const candidate = ref.credentialRef?.startsWith('vault://') ? ref.credentialRef.slice('vault://'.length) : undefined
    if (candidate) {
      const [mount, ...parts] = candidate.split('/').filter(Boolean)
      if (mount === this.mount && parts.length && parts.every(part => !isUnsafePathPart(part))) return parts.map(cleanPart).join('/')
    }
    return `${this.pathPrefix}/${encodeURIComponent(ref.accountId)}`
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { 'x-vault-token': this.options.token, accept: 'application/json' }
    if (this.namespace) headers['x-vault-namespace'] = this.namespace
    if (body !== undefined) headers['content-type'] = 'application/json'
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_VAULT_TIMEOUT_MS)
    try {
      return await this.fetchImpl(`${this.address}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal, redirect: 'error' })
    } finally {
      clearTimeout(timeout)
    }
  }

  private async json(response: Response): Promise<VaultPayload> {
    if (!response.ok) throw new Error('Vault credential read failed')
    const body: unknown = JSON.parse(await readBoundedResponseText(response, MAX_VAULT_RESPONSE_BYTES))
    return isRecord(body) ? body as VaultPayload : {}
  }
}

export function createVaultCredentialProviderFromEnv(source: Record<string, string | undefined> = process.env): CredentialProvider | undefined {
  const address = source.VAULT_ADDR?.trim()
  const token = source.VAULT_TOKEN?.trim()
  if (!address || !token) return undefined
  return new VaultKvCredentialProvider({
    address,
    token,
    mount: source.VAULT_KV_MOUNT,
    namespace: source.VAULT_NAMESPACE,
    pathPrefix: source.VAULT_CREDENTIAL_PATH_PREFIX,
  })
}
