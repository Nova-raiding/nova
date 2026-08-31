import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface ProviderUsageRecord {
  providerRecordId: string
  userId?: string
  createdAt?: string
  model?: string
  tokenName?: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  quota?: number
  raw: Record<string, unknown>
}

export interface ProviderUsagePage {
  items: ProviderUsageRecord[]
  total?: number
  page: number
  pageSize: number
  complete: boolean
}

export interface ProviderUsageStatement {
  records: ProviderUsageRecord[]
  pages: number
  complete: boolean
}

export interface NewApiSelfLogClientOptions {
  baseUrl: string
  userToken?: string
  refreshCookie?: string
  sessionFile?: string
  userId: string
  fetcher?: typeof fetch
  pageSize?: number
}

const MAX_PAGE_SIZE = 100
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

function integer(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^\d+$/u.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : undefined
  }
  return undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

async function boundedJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error('PROVIDER_USAGE_RESPONSE_TOO_LARGE')
  const reader = response.body?.getReader()
  if (!reader) return JSON.parse(await response.text()) as unknown
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new Error('PROVIDER_USAGE_RESPONSE_TOO_LARGE')
      chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  return JSON.parse(new TextDecoder().decode(concat(chunks, size))) as unknown
}

function concat(chunks: Uint8Array[], size: number) {
  const output = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength }
  return output
}

function parseRecord(value: unknown): ProviderUsageRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  const providerRecordId = text(row.id) ?? text(row.record_id) ?? text(row.request_id)
  if (!providerRecordId) return undefined
  const inputTokens = integer(row.prompt_tokens) ?? integer(row.input_tokens)
  const outputTokens = integer(row.completion_tokens) ?? integer(row.output_tokens)
  const totalTokens = integer(row.total_tokens) ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined)
  return { providerRecordId, ...(text(row.user_id) ? { userId: text(row.user_id) } : {}), ...(text(row.created_at) ? { createdAt: text(row.created_at) } : {}), ...(text(row.model_name) ? { model: text(row.model_name) } : {}), ...(text(row.token_name) ? { tokenName: text(row.token_name) } : {}), ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ...(totalTokens !== undefined ? { totalTokens } : {}), ...(typeof row.quota === 'number' && Number.isFinite(row.quota) ? { quota: row.quota } : {}), raw: row }
}

export class NewApiSelfLogClient {
  private readonly origin: URL
  private readonly fetcher: typeof fetch
  private readonly pageSize: number
  private userToken: string
  private refreshCookie: string
  private readonly sessionFile: string
  private sessionLoaded = false
  private refreshFlight?: Promise<void>

  constructor(private readonly options: NewApiSelfLogClientOptions) {
    this.origin = new URL(options.baseUrl)
    if (this.origin.protocol !== 'https:' && this.origin.hostname !== 'localhost' && this.origin.hostname !== '127.0.0.1') throw new Error('PROVIDER_USAGE_BASE_URL_MUST_BE_HTTPS')
    this.userToken = options.userToken?.trim() ?? ''
    this.refreshCookie = options.refreshCookie?.trim() ?? ''
    this.sessionFile = options.sessionFile?.trim() ?? ''
    if ((!this.userToken && !this.refreshCookie && !this.sessionFile) || !options.userId.trim()) throw new Error('PROVIDER_USAGE_USER_CREDENTIALS_REQUIRED')
    this.fetcher = options.fetcher ?? fetch
    this.pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(options.pageSize ?? MAX_PAGE_SIZE)))
  }

  private async loadPersistedSession() {
    if (this.sessionLoaded) return
    this.sessionLoaded = true
    if (!this.sessionFile) return
    try {
      const parsed = JSON.parse(await readFile(this.sessionFile, 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('PROVIDER_USAGE_SESSION_FILE_INVALID')
      const value = parsed as Record<string, unknown>
      const userToken = text(value.userToken)
      const refreshCookie = text(value.refreshCookie)
      if (!userToken && !refreshCookie) throw new Error('PROVIDER_USAGE_SESSION_FILE_INVALID')
      if (userToken) this.userToken = userToken
      if (refreshCookie) this.refreshCookie = refreshCookie
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private async persistSession() {
    if (!this.sessionFile) return
    const directory = dirname(this.sessionFile)
    const temporary = `${this.sessionFile}.${process.pid}.tmp`
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(temporary, JSON.stringify({ userToken: this.userToken, refreshCookie: this.refreshCookie }), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.sessionFile)
    await chmod(this.sessionFile, 0o600)
  }

  private async performRefresh() {
    if (!this.refreshCookie) throw new Error('PROVIDER_USAGE_USER_TOKEN_EXPIRED')
    const url = new URL('/api/user/auth/refresh', this.origin)
    const response = await this.fetcher(url, { method: 'POST', headers: { accept: 'application/json', cookie: this.refreshCookie }, redirect: 'error', signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`PROVIDER_USAGE_REFRESH_HTTP_${response.status}`)
    const payload = await boundedJson(response)
    const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : undefined
    const data = root?.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : undefined
    const accessToken = text(data?.access_token)
    if (!accessToken) throw new Error('PROVIDER_USAGE_REFRESH_RESPONSE_INVALID')
    this.userToken = accessToken
    const rotated = response.headers.getSetCookie?.().find(value => value.startsWith('new_api_refresh='))
    if (rotated) this.refreshCookie = rotated.split(';', 1)[0] ?? this.refreshCookie
    await this.persistSession()
  }

  private async refreshUserToken() {
    this.refreshFlight ??= this.performRefresh().finally(() => { this.refreshFlight = undefined })
    await this.refreshFlight
  }

  private async requestPage(url: URL) {
    await this.loadPersistedSession()
    if (!this.userToken) await this.refreshUserToken()
    const request = () => this.fetcher(url, { headers: { accept: 'application/json', authorization: `Bearer ${this.userToken}`, 'New-Api-User': this.options.userId }, redirect: 'error', signal: AbortSignal.timeout(10_000) })
    let response = await request()
    if (response.status === 401 && this.refreshCookie) {
      await this.refreshUserToken()
      response = await request()
    }
    return response
  }

  async listPage(input: { page?: number; startTimestamp?: number; endTimestamp?: number } = {}): Promise<ProviderUsagePage> {
    const page = Math.max(1, Math.trunc(input.page ?? 1))
    const url = new URL('/api/log/self', this.origin)
    url.searchParams.set('p', String(page)); url.searchParams.set('page_size', String(this.pageSize)); url.searchParams.set('type', '2')
    if (input.startTimestamp !== undefined) url.searchParams.set('start_timestamp', String(input.startTimestamp))
    if (input.endTimestamp !== undefined) url.searchParams.set('end_timestamp', String(input.endTimestamp))
    const response = await this.requestPage(url)
    if (!response.ok) throw new Error(`PROVIDER_USAGE_HTTP_${response.status}`)
    const payload = await boundedJson(response)
    const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : undefined
    const data = root?.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : undefined
    const values = Array.isArray(data?.items) ? data.items : Array.isArray(root?.items) ? root.items : undefined
    if (!values) throw new Error('PROVIDER_USAGE_RESPONSE_INVALID')
    const items = values.map(parseRecord)
    if (items.some(item => !item)) throw new Error('PROVIDER_USAGE_RECORD_INVALID')
    const total = integer(data?.total) ?? integer(root?.total)
    return { items: items as ProviderUsageRecord[], ...(total !== undefined ? { total } : {}), page, pageSize: this.pageSize, complete: total !== undefined ? page * this.pageSize >= total : items.length < this.pageSize }
  }

  async listAll(input: { startTimestamp?: number; endTimestamp?: number } = {}): Promise<ProviderUsageStatement> {
    const records: ProviderUsageRecord[] = []
    const seen = new Set<string>()
    for (let page = 1; page <= 1_000; page += 1) {
      const current = await this.listPage({ ...input, page })
      for (const record of current.items) {
        if (seen.has(record.providerRecordId)) throw new Error('PROVIDER_USAGE_DUPLICATE_RECORD')
        seen.add(record.providerRecordId)
        records.push(record)
      }
      if (current.complete) return { records, pages: page, complete: true }
    }
    throw new Error('PROVIDER_USAGE_PAGINATION_INCOMPLETE')
  }
}

export function createNewApiSelfLogClientFromEnv(env: NodeJS.ProcessEnv = process.env, fetcher?: typeof fetch) {
  const baseUrl = env.MODEL_RELAY_LOG_BASE_URL?.trim()
  const userToken = env.MODEL_RELAY_LOG_USER_TOKEN?.trim()
  const refreshCookie = env.MODEL_RELAY_LOG_REFRESH_COOKIE?.trim()
  const sessionFile = env.MODEL_RELAY_LOG_SESSION_FILE?.trim()
  const userId = env.MODEL_RELAY_LOG_USER_ID?.trim()
  if (!baseUrl || (!userToken && !refreshCookie && !sessionFile) || !userId) return undefined
  return new NewApiSelfLogClient({ baseUrl, ...(userToken ? { userToken } : {}), ...(refreshCookie ? { refreshCookie } : {}), ...(sessionFile ? { sessionFile } : {}), userId, ...(fetcher ? { fetcher } : {}) })
}
