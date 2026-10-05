import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'

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
  /** Provider-reported currency amount. Never derived from `quota`. */
  costCny?: number
  /** Currency attached to the provider-reported amount, when supplied. */
  costCurrency?: string
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

/** A provider log row that is strong enough to settle an actual-cost receipt.
 *
 * `quota` is deliberately absent from this contract: it is a relay billing
 * unit and cannot be converted to CNY without an independently bound pricing
 * snapshot. Callers that settle money must use this shape (or a stronger
 * provider-native receipt), never a raw `ProviderUsageRecord`.
 */
export type ProviderActualCostReceipt = ProviderUsageRecord & {
  costCny: number
  costCurrency?: string
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

async function secureSessionDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('PROVIDER_USAGE_SESSION_DIRECTORY_UNSAFE')
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY)
  try { await directory.sync() } finally { await directory.close() }
}

function integer(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^\d+$/u.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : undefined
  }
  return undefined
}

function nonNegativeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value.trim())) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
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
  // New API deployments have emitted both string and integer user IDs. Keep
  // the normalized identity so the actual-cost boundary can reject an
  // explicitly cross-user row instead of silently treating numeric IDs as
  // absent evidence.
  const providerUserId = text(row.user_id) ?? (typeof row.user_id === 'number' && Number.isSafeInteger(row.user_id) && row.user_id >= 0 ? String(row.user_id) : undefined)
  if (Object.prototype.hasOwnProperty.call(row, 'user_id') && providerUserId === undefined) return undefined
  const inputTokens = integer(row.prompt_tokens) ?? integer(row.input_tokens)
  const outputTokens = integer(row.completion_tokens) ?? integer(row.output_tokens)
  const totalTokens = integer(row.total_tokens) ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined)
  // New API's `quota` is an internal billing unit. Treating it as CNY would
  // fabricate actual-cost evidence, so only explicitly currency-named fields
  // can populate costCny. If such a field is present but malformed, reject the
  // row rather than silently downgrading it to an unpriced statement.
  const costKeys = ['cost_cny', 'costCny', 'actual_cost_cny', 'actualCostCny'].filter(key => Object.prototype.hasOwnProperty.call(row, key))
  const costs = costKeys.map(key => nonNegativeNumber(row[key]))
  const costCny = costs[0]
  if (costs.some(cost => cost === undefined || cost !== costCny)) return undefined
  const currencyKeys = ['currency', 'cost_currency', 'costCurrency'].filter(key => Object.prototype.hasOwnProperty.call(row, key))
  const currencies = currencyKeys.map(key => text(row[key])?.toUpperCase())
  const costCurrency = currencies[0]
  // A currency marker without an explicit amount is ambiguous evidence and
  // must not be persisted as a provider cost statement. Explicit non-CNY
  // amounts are likewise rejected before they can reach settlement.
  if (currencyKeys.length > 0 && costKeys.length === 0) return undefined
  if (currencies.some(currency => currency !== 'CNY')) return undefined
  return { providerRecordId, ...(providerUserId ? { userId: providerUserId } : {}), ...(text(row.created_at) ? { createdAt: text(row.created_at) } : {}), ...(text(row.model_name) ? { model: text(row.model_name) } : {}), ...(text(row.token_name) ? { tokenName: text(row.token_name) } : {}), ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ...(totalTokens !== undefined ? { totalTokens } : {}), ...(typeof row.quota === 'number' && Number.isFinite(row.quota) ? { quota: row.quota } : {}), ...(costCny !== undefined ? { costCny } : {}), ...(costCurrency ? { costCurrency } : {}), raw: row }
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
    this.sessionFile = options.sessionFile?.trim() ? resolve(options.sessionFile.trim()) : ''
    if ((!this.userToken && !this.refreshCookie && !this.sessionFile) || !options.userId.trim()) throw new Error('PROVIDER_USAGE_USER_CREDENTIALS_REQUIRED')
    this.fetcher = options.fetcher ?? fetch
    this.pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(options.pageSize ?? MAX_PAGE_SIZE)))
  }

  private async readPersistedSession(): Promise<{ userToken?: string; refreshCookie?: string } | undefined> {
    if (!this.sessionFile) return undefined
    await secureSessionDirectory(dirname(this.sessionFile))
    try {
      const stat = await lstat(this.sessionFile)
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('PROVIDER_USAGE_SESSION_FILE_UNSAFE')
      const parsed = JSON.parse(await readFile(this.sessionFile, 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('PROVIDER_USAGE_SESSION_FILE_INVALID')
      const value = parsed as Record<string, unknown>
      const userToken = text(value.userToken)
      const refreshCookie = text(value.refreshCookie)
      if (String(value.userId ?? '') !== this.options.userId.trim() || (!userToken && !refreshCookie) || (refreshCookie && !/^new_api_refresh=[^;\s]+$/u.test(refreshCookie))) throw new Error('PROVIDER_USAGE_SESSION_FILE_INVALID')
      return { ...(userToken ? { userToken } : {}), ...(refreshCookie ? { refreshCookie } : {}) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private async loadPersistedSession() {
    if (this.sessionLoaded) return
    const persisted = await this.readPersistedSession()
    if (persisted?.userToken) this.userToken = persisted.userToken
    if (persisted?.refreshCookie) this.refreshCookie = persisted.refreshCookie
    this.sessionLoaded = true
  }

  private async persistSession() {
    const directory = dirname(this.sessionFile)
    const temporary = `${this.sessionFile}.${process.pid}.${randomUUID()}.tmp`
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try {
      await file.writeFile(`${JSON.stringify({ userToken: this.userToken, refreshCookie: this.refreshCookie, userId: this.options.userId.trim() })}\n`)
      await file.sync()
    } finally { await file.close() }
    await rename(temporary, this.sessionFile)
    await syncDirectory(directory)
  }

  private async performRefresh() {
    if (!this.sessionFile) throw new Error('PROVIDER_USAGE_SESSION_FILE_REQUIRED_FOR_REFRESH')
    const directory = dirname(this.sessionFile)
    await secureSessionDirectory(directory)
    const lockPath = `${this.sessionFile}.lock`
    const lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try {
      await lock.writeFile(`${process.pid}\n`)
      await lock.sync()
      await syncDirectory(directory)
      const previousToken = this.userToken
      const persisted = await this.readPersistedSession()
      if (persisted?.userToken) this.userToken = persisted.userToken
      if (persisted?.refreshCookie) this.refreshCookie = persisted.refreshCookie
      if (persisted?.userToken && persisted.userToken !== previousToken) {
        await unlink(lockPath)
        await syncDirectory(directory)
        return
      }
      if (!this.refreshCookie) throw new Error('PROVIDER_USAGE_USER_TOKEN_EXPIRED')
      const url = new URL('/api/user/auth/refresh', this.origin)
      const response = await this.fetcher(url, { method: 'POST', headers: { accept: 'application/json', cookie: this.refreshCookie, origin: this.origin.origin }, redirect: 'error', signal: AbortSignal.timeout(10_000) })
      if (!response.ok) throw new Error(`PROVIDER_USAGE_REFRESH_HTTP_${response.status}`)
      const payload = await boundedJson(response)
      const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : undefined
      const data = root?.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : undefined
      const accessToken = text(data?.access_token)
      const user = data?.user && typeof data.user === 'object' ? data.user as Record<string, unknown> : undefined
      if (!accessToken || String(user?.id ?? '') !== this.options.userId.trim()) throw new Error('PROVIDER_USAGE_REFRESH_IDENTITY_INVALID')
      const cookies = response.headers.getSetCookie().filter(value => value.startsWith('new_api_refresh='))
      const rotated = cookies.length === 1 ? cookies[0] : undefined
      if (!rotated || !/^new_api_refresh=[^;\s]+(?:;|$)/u.test(rotated) || !/;\s*HttpOnly(?:;|$)/iu.test(rotated) || !/;\s*Secure(?:;|$)/iu.test(rotated) || !/;\s*Path=\/api\/user\/auth(?:;|$)/iu.test(rotated)) throw new Error('PROVIDER_USAGE_REFRESH_ROTATION_INVALID')
      this.userToken = accessToken
      this.refreshCookie = rotated.split(';', 1)[0]!
      await this.persistSession()
      await unlink(lockPath)
      await syncDirectory(directory)
    } finally {
      await lock.close()
      // Any uncertain remote response or crash keeps the lock. Recovery is manual.
    }
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

  /**
   * Read the provider's own usage log as actual-cost evidence.
   *
   * This intentionally rejects a complete statement when any row has only
   * quota/token data. A statement with mixed priced and unpriced rows cannot
   * safely be used for settlement because selecting a subset would make the
   * accounting boundary ambiguous. The request ID match is exact and the
   * duplicate guard in listAll remains authoritative.
   */
  async readActualCostReceipt(providerRequestId: string, input: { startTimestamp?: number; endTimestamp?: number } = {}): Promise<ProviderActualCostReceipt> {
    const requestId = providerRequestId.trim()
    if (!requestId || requestId.length > 256 || /[\u0000-\u001f\u007f]/u.test(requestId)) throw new Error('PROVIDER_USAGE_REQUEST_ID_INVALID')
    const statement = await this.listAll(input)
    // The endpoint is user-scoped, but a provider response may still contain
    // an explicit user_id field. Never allow a row that names another user to
    // cross the settlement boundary: accepting it would turn a valid session
    // into cross-tenant billing evidence. Rows that omit user_id remain bound
    // by the authenticated request and the `New-Api-User` header.
    if (statement.records.some(record => record.userId !== undefined && record.userId !== this.options.userId.trim())) {
      throw new Error('PROVIDER_USAGE_IDENTITY_MISMATCH')
    }
    const unpriced = statement.records.find(record => record.costCny === undefined || (record.costCurrency !== undefined && record.costCurrency.toUpperCase() !== 'CNY'))
    if (unpriced) throw new Error('PROVIDER_USAGE_ACTUAL_COST_INCOMPLETE')
    const matches = statement.records.filter(record => record.providerRecordId === requestId)
    if (matches.length === 0) throw new Error('PROVIDER_USAGE_RECEIPT_NOT_FOUND')
    if (matches.length !== 1) throw new Error('PROVIDER_USAGE_RECEIPT_DUPLICATE')
    const receipt = matches[0]
    if (!receipt || receipt.costCny === undefined || !Number.isFinite(receipt.costCny) || receipt.costCny < 0) throw new Error('PROVIDER_USAGE_ACTUAL_COST_INVALID')
    return receipt as ProviderActualCostReceipt
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
