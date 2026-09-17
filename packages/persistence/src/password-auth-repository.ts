import { randomUUID } from 'node:crypto'
import { createHash, randomBytes } from 'node:crypto'
import argon2 from 'argon2'
import type { SqlClient, SqlPool } from './repository.js'

const newOpaqueToken = (bytes = 32) => randomBytes(bytes).toString('base64url')
const tokenDigest = (token: string) => createHash('sha256').update(token).digest('hex')
const normalizeLogin = (value: string) => value.trim().toLowerCase()
const validatePassword = (password: string) => { if (typeof password !== 'string' || password.length < 8 || password.length > 256 || !/[A-Za-z]/u.test(password) || !/[0-9]/u.test(password)) throw new Error('PASSWORD_POLICY_INVALID') }
const hashPassword = async (password: string) => { validatePassword(password); return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 }) }
const verifyPassword = async (hash: string, password: string) => { if (!hash || typeof password !== 'string' || password.length > 256) return false; try { return await argon2.verify(hash, password) } catch { return false } }

export type PasswordAccountType = 'merchant' | 'platform'
export type PasswordAccountStatus = 'merchant_pending' | 'active' | 'suspended' | 'revoked' | 'rejected'
export interface PasswordAccount {
  id: string
  /** Stable platform identity key used by RBAC/JIT/RLS, distinct from the
   * password-account row key in PostgreSQL. Memory auth uses the same value. */
  identityId: string
  login: string
  accountType: PasswordAccountType
  enterpriseName?: string
  contactName?: string
  status: PasswordAccountStatus
  roles: string[]
  workspaceIds: string[]
  failedAttempts: number
  lockedUntil?: string
  revision: number
  createdAt: string
  updatedAt: string
}
export interface PasswordSessionPrincipal {
  account: PasswordAccount
  sessionId: string
  issuedAt: string
  expiresAt: string
}
export interface McpOAuthContext {
  clientId: string
  issuer: string
  audience: string
  resource: string
  scope: string[]
}
export interface McpOAuthPrincipal {
  identityId: string
  accountId: string
  accountLogin: string
  workspaceId: string
  scope: string[]
  tokenId: string
  issuedAt: string
  expiresAt: string
}
export interface McpOAuthTokenPair {
  accessToken: string
  refreshToken: string
  expiresIn: number
  scope: string[]
}
export interface PasswordAuthRepository {
  register(input: { login: string; password: string; enterpriseName: string; contactName: string; termsAgreed: boolean }): Promise<{ account: PasswordAccount; applicationId: string }>
  createMerchantAccount(input: { login: string; password: string; enterpriseName: string; contactName: string; workspaceIds: string[]; actorId: string; reason: string }): Promise<PasswordAccount>
  listAccounts(): Promise<PasswordAccount[]>
  login(input: { login: string; password: string; ip?: string; userAgent?: string }): Promise<{ token: string; principal: PasswordSessionPrincipal }>
  authenticate(token: string): Promise<PasswordSessionPrincipal | undefined>
  changePassword(input: { token: string; currentPassword: string; newPassword: string }): Promise<void>
  logout(token: string, reason?: string): Promise<void>
  refresh(token: string): Promise<{ token: string; principal: PasswordSessionPrincipal }>
  requestPasswordReset(login: string): Promise<{ accepted: true; token?: string }>
  confirmPasswordReset(token: string, password: string): Promise<void>
  ensurePlatformAccount(input: { login: string; passwordHash: string; roles?: string[] }): Promise<void>
  activateMerchantAccount(input: { login: string; workspaceIds: string[]; actorId?: string; reason?: string }): Promise<PasswordAccount>
  reviewMerchantRegistration(input: { login: string; decision: 'approved' | 'rejected'; workspaceIds?: string[]; actorId?: string; reason: string }): Promise<PasswordAccount>
  issueMcpAuthorizationCode(input: McpOAuthContext & { account: PasswordAccount; redirectUri: string; codeChallenge: string }): Promise<{ code: string; expiresAt: string; workspaceId: string }>
  exchangeMcpAuthorizationCode(input: McpOAuthContext & { redirectUri: string; code: string; codeVerifier: string }): Promise<McpOAuthTokenPair>
  refreshMcpOAuthToken(input: McpOAuthContext & { refreshToken: string }): Promise<McpOAuthTokenPair>
  revokeMcpOAuthToken(input: McpOAuthContext & { token: string; tokenTypeHint?: 'access_token' | 'refresh_token' }): Promise<void>
  authenticateMcpAccessToken(input: McpOAuthContext & { accessToken: string }): Promise<McpOAuthPrincipal | undefined>
}

type AccountRecord = PasswordAccount & { passwordHash: string; authEpoch: number }
type SessionRecord = PasswordSessionPrincipal & { tokenHash: string; authEpoch: number; status: 'active' | 'revoked' }
type ResetRecord = { accountId: string; tokenHash: string; expiresAt: number; used: boolean }
type McpCodeRecord = McpOAuthContext & { accountId: string; identityId: string; workspaceId: string; redirectUri: string; codeHash: string; codeChallenge: string; accountAuthEpoch: number; identityAuthEpoch: number; expiresAt: number; used: boolean }
type McpTokenRecord = McpOAuthContext & { id: string; familyId: string; accountId: string; identityId: string; workspaceId: string; tokenHash: string; kind: 'access' | 'refresh'; accountAuthEpoch: number; identityAuthEpoch: number; issuedAt: number; expiresAt: number; status: 'active' | 'rotated' | 'revoked' }

const GENERIC_LOGIN_ERROR = '账号或密码错误'
const LOCK_MS = 15 * 60_000
const SESSION_MS = 8 * 60 * 60_000
const RESET_MS = 15 * 60_000
const MCP_CODE_MS = 5 * 60_000
const MCP_ACCESS_MS = 10 * 60_000
const MCP_REFRESH_MS = 30 * 24 * 60 * 60_000
const loginError = () => Object.assign(new Error(GENERIC_LOGIN_ERROR), { code: 'AUTH_INVALID_CREDENTIALS' })
const mcpOAuthError = (code: string) => Object.assign(new Error(code), { code })
const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')
const validPkceVerifier = (verifier: string) => /^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)
const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString()

function accountPublic(value: AccountRecord): PasswordAccount {
  const { passwordHash: _passwordHash, authEpoch: _authEpoch, ...account } = value
  return account
}
function assertLogin(login: string) {
  const normalized = normalizeLogin(login)
  if (!/^[a-z0-9][a-z0-9._%+\-@]{2,127}$/u.test(normalized)) throw Object.assign(new Error('LOGIN_INVALID'), { code: 'AUTH_LOGIN_INVALID' })
  return normalized
}
function assertRegistration(input: { login: string; password: string; enterpriseName: string; contactName: string; termsAgreed: boolean }) {
  const login = assertLogin(input.login)
  if (!input.enterpriseName?.trim() || input.enterpriseName.trim().length > 200 || !input.contactName?.trim() || input.contactName.trim().length > 100 || input.termsAgreed !== true) throw Object.assign(new Error('REGISTRATION_INVALID'), { code: 'AUTH_REGISTRATION_INVALID' })
  return login
}
function auditMemory(events: Array<Record<string, unknown>>, eventType: string, accountId: string, evidence: Record<string, unknown> = {}) { events.push({ id: randomUUID(), eventType, accountId, evidence, createdAt: new Date().toISOString() }) }

export class MemoryPasswordAuthRepository implements PasswordAuthRepository {
  private readonly accounts = new Map<string, AccountRecord>()
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly resets = new Map<string, ResetRecord>()
  private readonly mcpCodes = new Map<string, McpCodeRecord>()
  private readonly mcpTokens = new Map<string, McpTokenRecord>()
  readonly events: Array<Record<string, unknown>> = []

  async register(input: { login: string; password: string; enterpriseName: string; contactName: string; termsAgreed: boolean }) {
    const login = assertRegistration(input)
    if (this.accounts.has(login)) throw Object.assign(new Error('LOGIN_ALREADY_EXISTS'), { code: 'AUTH_LOGIN_ALREADY_EXISTS' })
    let passwordHash: string
    try { passwordHash = await hashPassword(input.password) } catch (error) { if ((error as Error).message === 'PASSWORD_POLICY_INVALID') throw Object.assign(new Error('PASSWORD_POLICY_INVALID'), { code: 'AUTH_PASSWORD_POLICY_INVALID' }); throw error }
    const now = new Date().toISOString()
    const accountId = randomUUID()
    const account: AccountRecord = { id: accountId, identityId: accountId, login, accountType: 'merchant', enterpriseName: input.enterpriseName.trim(), contactName: input.contactName.trim(), status: 'merchant_pending', roles: ['merchant'], workspaceIds: [], failedAttempts: 0, revision: 1, authEpoch: 1, createdAt: now, updatedAt: now, passwordHash }
    this.accounts.set(login, account)
    auditMemory(this.events, 'auth.registered', account.id, { account_type: account.accountType, status: account.status })
    return { account: accountPublic(account), applicationId: account.id }
  }
  async reviewMerchantRegistration(input: { login: string; decision: 'approved' | 'rejected'; workspaceIds?: string[]; actorId?: string; reason: string }) {
    const account = this.accounts.get(normalizeLogin(input.login));
    if (!account || account.accountType !== 'merchant') throw Object.assign(new Error('AUTH_ACCOUNT_NOT_FOUND'), { code: 'AUTH_ACCOUNT_NOT_FOUND' });
    if (account.status !== 'merchant_pending') throw Object.assign(new Error('AUTH_REGISTRATION_STATE_INVALID'), { code: 'AUTH_REGISTRATION_STATE_INVALID' });
    if (input.reason.trim().length < 4) throw Object.assign(new Error('AUTH_REGISTRATION_REVIEW_INVALID'), { code: 'AUTH_REGISTRATION_REVIEW_INVALID' });
    account.status = input.decision === 'approved' ? 'active' : 'rejected';
    account.workspaceIds = input.decision === 'approved' ? [...new Set((input.workspaceIds ?? []).map(v => v.trim()).filter(Boolean))] : [];
    account.revision += 1; account.updatedAt = new Date().toISOString();
    auditMemory(this.events, input.decision === 'approved' ? 'auth.merchant_activated' : 'auth.merchant_rejected', account.id, { actor_id: input.actorId ?? 'system', reason: input.reason.trim(), workspace_ids: account.workspaceIds });
    return accountPublic(account);
  }

  async ensurePlatformAccount(input: { login: string; passwordHash: string; roles?: string[] }) {
    const login = assertLogin(input.login)
    const existing = this.accounts.get(login)
    if (existing) return
    const now = new Date().toISOString()
    const accountId = randomUUID()
    this.accounts.set(login, { id: accountId, identityId: accountId, login, accountType: 'platform', status: 'active', roles: input.roles?.length ? [...new Set(input.roles)] : ['platform_admin'], workspaceIds: [], failedAttempts: 0, revision: 1, authEpoch: 1, createdAt: now, updatedAt: now, passwordHash: input.passwordHash })
    auditMemory(this.events, 'auth.platform_preseeded', login, { account_type: 'platform' })
  }

  async createMerchantAccount(input: { login: string; password: string; enterpriseName: string; contactName: string; workspaceIds: string[]; actorId: string; reason: string }) {
    const login = assertRegistration({ ...input, termsAgreed: true })
    if (!input.workspaceIds.length || !input.actorId.trim() || input.reason.trim().length < 4) throw Object.assign(new Error('ACCOUNT_PROVISIONING_INVALID'), { code: 'AUTH_ACCOUNT_PROVISIONING_INVALID' })
    if (this.accounts.has(login)) throw Object.assign(new Error('LOGIN_ALREADY_EXISTS'), { code: 'AUTH_LOGIN_ALREADY_EXISTS' })
    let passwordHash: string
    try { passwordHash = await hashPassword(input.password) } catch (error) { if ((error as Error).message === 'PASSWORD_POLICY_INVALID') throw Object.assign(new Error('PASSWORD_POLICY_INVALID'), { code: 'AUTH_PASSWORD_POLICY_INVALID' }); throw error }
    const now = new Date().toISOString()
    const accountId = randomUUID()
    const account: AccountRecord = { id: accountId, identityId: accountId, login, accountType: 'merchant', enterpriseName: input.enterpriseName.trim(), contactName: input.contactName.trim(), status: 'active', roles: ['merchant'], workspaceIds: [...new Set(input.workspaceIds.map(value => value.trim()).filter(Boolean))], failedAttempts: 0, revision: 1, authEpoch: 1, createdAt: now, updatedAt: now, passwordHash }
    this.accounts.set(login, account)
    auditMemory(this.events, 'auth.merchant_created', account.id, { workspace_ids: account.workspaceIds, actor_id: input.actorId, reason: input.reason })
    return accountPublic(account)
  }

  async listAccounts() {
    return [...this.accounts.values()].map(accountPublic)
  }

  async activateMerchantAccount(input: { login: string; workspaceIds: string[]; actorId?: string; reason?: string }) {
    const login = assertLogin(input.login)
    const account = this.accounts.get(login)
    if (!account || account.accountType !== 'merchant') throw Object.assign(new Error('AUTH_ACCOUNT_NOT_FOUND'), { code: 'AUTH_ACCOUNT_NOT_FOUND' })
    account.status = 'active'; account.workspaceIds = [...new Set(input.workspaceIds.map(value => value.trim()).filter(Boolean))]; account.revision += 1; account.updatedAt = new Date().toISOString()
    auditMemory(this.events, 'auth.merchant_activated', account.id, { workspace_ids: account.workspaceIds })
    return accountPublic(account)
  }

  async login(input: { login: string; password: string; ip?: string; userAgent?: string }) {
    const login = assertLogin(input.login)
    const account = this.accounts.get(login)
    const now = Date.now()
    if (account?.lockedUntil && Date.parse(account.lockedUntil) > now) { auditMemory(this.events, 'auth.locked', account.id); throw Object.assign(new Error('AUTH_ACCOUNT_LOCKED'), { code: 'AUTH_ACCOUNT_LOCKED' }) }
    const valid = account ? await verifyPassword(account.passwordHash, input.password) : false
    if (account && valid && account.status !== 'active') {
      auditMemory(this.events, 'auth.login_blocked', account.id, { status: account.status })
      throw Object.assign(new Error('AUTH_ACCOUNT_NOT_ACTIVE'), { code: 'AUTH_ACCOUNT_NOT_ACTIVE' })
    }
    if (!account || !valid) {
      if (account) { account.failedAttempts += 1; account.updatedAt = new Date().toISOString(); if (account.failedAttempts >= 5) account.lockedUntil = new Date(now + LOCK_MS).toISOString(); auditMemory(this.events, account.failedAttempts >= 5 ? 'auth.locked' : 'auth.login_failed', account.id, { attempts: account.failedAttempts }) }
      throw loginError()
    }
    account.failedAttempts = 0; account.lockedUntil = undefined; account.updatedAt = new Date().toISOString()
    const token = newOpaqueToken(); const issuedAt = new Date(now).toISOString(); const expiresAt = new Date(now + SESSION_MS).toISOString()
    const session: SessionRecord = { tokenHash: tokenDigest(token), sessionId: randomUUID(), account: accountPublic(account), issuedAt, expiresAt, authEpoch: account.authEpoch, status: 'active' }
    this.sessions.set(session.tokenHash, session); auditMemory(this.events, 'auth.login_succeeded', account.id, { session_id: session.sessionId })
    return { token, principal: { account: session.account, sessionId: session.sessionId, issuedAt, expiresAt } }
  }

  async authenticate(token: string) {
    const session = this.sessions.get(tokenDigest(token)); if (!session || session.status !== 'active') return undefined
    const account = [...this.accounts.values()].find(item => item.id === session.account.id)
    if (!account || account.authEpoch !== session.authEpoch || account.status === 'suspended' || account.status === 'revoked' || Date.parse(session.expiresAt) <= Date.now()) { if (session) session.status = 'revoked'; return undefined }
    return { account: accountPublic(account), sessionId: session.sessionId, issuedAt: session.issuedAt, expiresAt: session.expiresAt }
  }
  async changePassword(input: { token: string; currentPassword: string; newPassword: string }) {
    const current = await this.authenticate(input.token)
    if (!current) throw Object.assign(new Error('AUTH_SESSION_INVALID'), { code: 'AUTH_SESSION_INVALID' })
    const account = this.accounts.get(current.account.login)
    if (!account || !(await verifyPassword(account.passwordHash, input.currentPassword))) throw Object.assign(new Error('AUTH_CURRENT_PASSWORD_INVALID'), { code: 'AUTH_CURRENT_PASSWORD_INVALID' })
    try { account.passwordHash = await hashPassword(input.newPassword) } catch (error) {
      if ((error as Error).message === 'PASSWORD_POLICY_INVALID') throw Object.assign(new Error('PASSWORD_POLICY_INVALID'), { code: 'AUTH_PASSWORD_POLICY_INVALID' })
      throw error
    }
    account.authEpoch += 1; account.revision += 1; account.updatedAt = new Date().toISOString()
    for (const session of this.sessions.values()) if (session.account.id === account.id) session.status = 'revoked'
    auditMemory(this.events, 'auth.password_changed', account.id, { sessions_revoked: true })
  }
  async logout(token: string, reason = 'user_logout') { const session = this.sessions.get(tokenDigest(token)); if (session && session.status === 'active') { session.status = 'revoked'; auditMemory(this.events, 'auth.logout', session.account.id, { session_id: session.sessionId, reason }) } }
  async refresh(token: string) { const current = await this.authenticate(token); if (!current) throw Object.assign(new Error('AUTH_SESSION_INVALID'), { code: 'AUTH_SESSION_INVALID' }); await this.logout(token, 'session_refresh'); const account = this.accounts.get(current.account.login)!; const raw = newOpaqueToken(); const now = Date.now(); const session: SessionRecord = { tokenHash: tokenDigest(raw), sessionId: randomUUID(), account: accountPublic(account), issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + SESSION_MS).toISOString(), authEpoch: account.authEpoch, status: 'active' }; this.sessions.set(session.tokenHash, session); auditMemory(this.events, 'auth.refresh', account.id, { session_id: session.sessionId }); return { token: raw, principal: { account: session.account, sessionId: session.sessionId, issuedAt: session.issuedAt, expiresAt: session.expiresAt } } }
  async requestPasswordReset(loginInput: string) { const login = normalizeLogin(loginInput); const account = this.accounts.get(login); if (!account) return { accepted: true as const }; const token = newOpaqueToken(32); this.resets.set(tokenDigest(token), { accountId: account.id, tokenHash: tokenDigest(token), expiresAt: Date.now() + RESET_MS, used: false }); auditMemory(this.events, 'auth.password_reset_requested', account.id); return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true' ? { accepted: true as const, token } : { accepted: true as const } }
  async confirmPasswordReset(token: string, password: string) { const record = this.resets.get(tokenDigest(token)); if (!record || record.used || record.expiresAt <= Date.now()) throw Object.assign(new Error('AUTH_RESET_TOKEN_INVALID'), { code: 'AUTH_RESET_TOKEN_INVALID' }); const account = [...this.accounts.values()].find(item => item.id === record.accountId)!; account.passwordHash = await hashPassword(password); account.authEpoch += 1; account.failedAttempts = 0; account.lockedUntil = undefined; account.revision += 1; account.updatedAt = new Date().toISOString(); record.used = true; for (const session of this.sessions.values()) if (session.account.id === account.id) session.status = 'revoked'; auditMemory(this.events, 'auth.password_reset_confirmed', account.id, { sessions_revoked: true }) }
  async issueMcpAuthorizationCode(input: McpOAuthContext & { account: PasswordAccount; redirectUri: string; codeChallenge: string }) {
    const account = this.accounts.get(input.account.login)
    if (!account || account.id !== input.account.id || account.accountType !== 'merchant' || account.status !== 'active') throw mcpOAuthError('MCP_OAUTH_ACCOUNT_INVALID')
    const workspaceIds = [...new Set(account.workspaceIds.filter(Boolean))]
    if (workspaceIds.length !== 1) throw mcpOAuthError('MCP_OAUTH_WORKSPACE_AMBIGUOUS')
    const code = newOpaqueToken()
    const expiresAt = Date.now() + MCP_CODE_MS
    this.mcpCodes.set(tokenDigest(code), { ...input, accountId: account.id, identityId: account.identityId, workspaceId: workspaceIds[0]!, codeHash: tokenDigest(code), accountAuthEpoch: account.authEpoch, identityAuthEpoch: account.authEpoch, expiresAt, used: false })
    return { code, expiresAt: new Date(expiresAt).toISOString(), workspaceId: workspaceIds[0]! }
  }
  private issueMemoryMcpTokenPair(code: McpCodeRecord | McpTokenRecord, familyId: string = randomUUID()): McpOAuthTokenPair {
    const now = Date.now(); const accessToken = newOpaqueToken(); const refreshToken = newOpaqueToken()
    const common = { clientId: code.clientId, issuer: code.issuer, audience: code.audience, resource: code.resource, scope: [...code.scope], accountId: code.accountId, identityId: code.identityId, workspaceId: code.workspaceId, accountAuthEpoch: code.accountAuthEpoch, identityAuthEpoch: code.identityAuthEpoch, familyId, issuedAt: now, status: 'active' as const }
    const access: McpTokenRecord = { ...common, id: randomUUID(), kind: 'access', tokenHash: tokenDigest(accessToken), expiresAt: now + MCP_ACCESS_MS }
    const refresh: McpTokenRecord = { ...common, id: randomUUID(), kind: 'refresh', tokenHash: tokenDigest(refreshToken), expiresAt: now + MCP_REFRESH_MS }
    this.mcpTokens.set(access.tokenHash, access); this.mcpTokens.set(refresh.tokenHash, refresh)
    return { accessToken, refreshToken, expiresIn: MCP_ACCESS_MS / 1000, scope: [...code.scope] }
  }
  async exchangeMcpAuthorizationCode(input: McpOAuthContext & { redirectUri: string; code: string; codeVerifier: string }) {
    if (!validPkceVerifier(input.codeVerifier)) throw mcpOAuthError('MCP_OAUTH_INVALID_GRANT')
    const record = this.mcpCodes.get(tokenDigest(input.code))
    if (!record || record.used || record.expiresAt <= Date.now() || record.clientId !== input.clientId || record.redirectUri !== input.redirectUri || record.issuer !== input.issuer || record.audience !== input.audience || record.resource !== input.resource || !record.scope.includes('merchant') || pkceChallenge(input.codeVerifier) !== record.codeChallenge) throw mcpOAuthError('MCP_OAUTH_INVALID_GRANT')
    const account = [...this.accounts.values()].find(item => item.id === record.accountId)
    if (!account || account.status !== 'active' || account.authEpoch !== record.accountAuthEpoch || account.workspaceIds.length !== 1 || account.workspaceIds[0] !== record.workspaceId) throw mcpOAuthError('MCP_OAUTH_INVALID_GRANT')
    record.used = true
    return this.issueMemoryMcpTokenPair(record)
  }
  private activeMemoryMcpToken(record: McpTokenRecord, input: McpOAuthContext) {
    const account = [...this.accounts.values()].find(item => item.id === record.accountId)
    return record.status === 'active' && record.expiresAt > Date.now() && record.clientId === input.clientId && record.issuer === input.issuer && record.audience === input.audience && record.resource === input.resource && record.scope.includes('merchant') && Boolean(account && account.status === 'active' && account.authEpoch === record.accountAuthEpoch && account.workspaceIds.length === 1 && account.workspaceIds[0] === record.workspaceId)
  }
  async refreshMcpOAuthToken(input: McpOAuthContext & { refreshToken: string }) {
    const record = this.mcpTokens.get(tokenDigest(input.refreshToken))
    if (!record || record.kind !== 'refresh' || !this.activeMemoryMcpToken(record, input)) {
      if (record) for (const token of this.mcpTokens.values()) if (token.familyId === record.familyId && token.status === 'active') token.status = 'revoked'
      throw mcpOAuthError('MCP_OAUTH_INVALID_GRANT')
    }
    record.status = 'rotated'
    return this.issueMemoryMcpTokenPair(record, record.familyId)
  }
  async revokeMcpOAuthToken(input: McpOAuthContext & { token: string; tokenTypeHint?: 'access_token' | 'refresh_token' }) {
    const record = this.mcpTokens.get(tokenDigest(input.token))
    if (!record || record.clientId !== input.clientId || record.issuer !== input.issuer || record.audience !== input.audience || record.resource !== input.resource) return
    if (record.kind === 'refresh') {
      for (const token of this.mcpTokens.values()) if (token.familyId === record.familyId && token.status === 'active') token.status = 'revoked'
    } else if (record.status === 'active') record.status = 'revoked'
  }
  async authenticateMcpAccessToken(input: McpOAuthContext & { accessToken: string }) {
    const record = this.mcpTokens.get(tokenDigest(input.accessToken))
    const account = record ? [...this.accounts.values()].find(item => item.id === record.accountId) : undefined
    if (!record || record.kind !== 'access' || record.status !== 'active' || record.expiresAt <= Date.now() || record.clientId !== input.clientId || record.issuer !== input.issuer || record.audience !== input.audience || record.resource !== input.resource || input.scope.some(scope => !record.scope.includes(scope)) || !record.scope.includes('merchant') || !account || account.status !== 'active' || account.authEpoch !== record.accountAuthEpoch || account.workspaceIds.length !== 1 || account.workspaceIds[0] !== record.workspaceId) return undefined
    return { identityId: record.identityId, accountId: record.accountId, accountLogin: account.login, workspaceId: record.workspaceId, scope: [...record.scope], tokenId: record.id, issuedAt: new Date(record.issuedAt).toISOString(), expiresAt: new Date(record.expiresAt).toISOString() }
  }
}

/** PostgreSQL adapter. All auth tables live in the isolated control-plane
 * database role; only digests and Argon2id hashes are persisted. */
export class PostgresPasswordAuthRepository implements PasswordAuthRepository {
  constructor(private readonly pool: SqlPool) {}
  private async withClient<T>(fn: (client: SqlClient) => Promise<T>) { const client = await this.pool.connect(); try { await client.query('BEGIN'); await client.query(`SELECT set_config('app.platform_scope', 'platform_ops', true)`); const value = await fn(client); await client.query('COMMIT'); return value } catch (error) { try { await client.query('ROLLBACK') } catch {} throw error } finally { client.release?.() } }
  private async syncEnterpriseName(client: SqlClient, workspaceIds: readonly string[], enterpriseName: string) {
    const normalized = enterpriseName.trim()
    if (!normalized || !workspaceIds.length) return
    await client.query(
      'SELECT public.sync_enterprise_name_for_workspaces($1::text[], $2::text)',
      [workspaceIds, normalized],
    )
  }
  private async find(client: SqlClient, login: string) { const result = await client.query<any>(`SELECT id, identity_id AS "identityId", login_identifier AS login, account_type AS "accountType", enterprise_name AS "enterpriseName", contact_name AS "contactName", password_hash AS "passwordHash", status, roles, workspace_ids AS "workspaceIds", failed_attempts AS "failedAttempts", locked_until AS "lockedUntil", auth_epoch AS "authEpoch", revision, created_at AS "createdAt", updated_at AS "updatedAt" FROM platform_password_accounts WHERE login_identifier=$1`, [login]); return result.rows[0] as (AccountRecord & { identityId: string }) | undefined }
  private public(account: AccountRecord) { return accountPublic({ ...account, createdAt: iso(account.createdAt), updatedAt: iso(account.updatedAt) }) }
  async register(input: { login: string; password: string; enterpriseName: string; contactName: string; termsAgreed: boolean }) { const login = assertRegistration(input); const passwordHash = await hashPassword(input.password); return this.withClient(async client => { const identityId = randomUUID(); const applicationId = randomUUID(); try { await client.query(`INSERT INTO platform_identities (id, issuer, external_subject, display_name) VALUES ($1,'damai-password',$2,$3)`, [identityId, login, input.contactName.trim()]); await client.query(`INSERT INTO platform_password_accounts (id, identity_id, login_identifier, account_type, enterprise_name, contact_name, password_hash, terms_agreed_at, status, roles, workspace_ids) VALUES ($1,$2,$3,'merchant',$4,$5,$6,now(),'merchant_pending',ARRAY['merchant'],ARRAY[]::text[])`, [applicationId, identityId, login, input.enterpriseName.trim(), input.contactName.trim(), passwordHash]); await client.query(`INSERT INTO platform_identity_events (id,identity_id,event_type,actor_id,reason,evidence_json) VALUES ($1,$2,'auth.registered',$3,'merchant registration',$4)`, [randomUUID(), identityId, login, { account_type: 'merchant', status: 'merchant_pending' }]) } catch (error) { if ((error as { code?: string }).code === '23505') throw Object.assign(new Error('LOGIN_ALREADY_EXISTS'), { code: 'AUTH_LOGIN_ALREADY_EXISTS' }); throw error } const account = await this.find(client, login); return { account: this.public(account!), applicationId } }) }
  async createMerchantAccount(input: { login: string; password: string; enterpriseName: string; contactName: string; workspaceIds: string[]; actorId: string; reason: string }) {
    const login = assertRegistration({ ...input, termsAgreed: true })
    const workspaceIds = [...new Set(input.workspaceIds.map(value => value.trim()).filter(Boolean))]
    if (!workspaceIds.length || !input.actorId.trim() || input.reason.trim().length < 4) throw Object.assign(new Error('ACCOUNT_PROVISIONING_INVALID'), { code: 'AUTH_ACCOUNT_PROVISIONING_INVALID' })
    const passwordHash = await hashPassword(input.password)
    return this.withClient(async client => {
      const workspaces = await client.query<{ id: string }>('SELECT id FROM workspaces WHERE id = ANY($1::text[]) AND status = $2', [workspaceIds, 'active'])
      if (workspaces.rows.length !== workspaceIds.length) throw Object.assign(new Error('WORKSPACE_NOT_FOUND'), { code: 'AUTH_WORKSPACE_NOT_FOUND' })
      const identityId = randomUUID()
      const accountId = randomUUID()
      try {
        await client.query(`INSERT INTO platform_identities (id, issuer, external_subject, display_name) VALUES ($1,'damai-password',$2,$3)`, [identityId, login, input.contactName.trim()])
        await client.query(`INSERT INTO platform_password_accounts (id, identity_id, login_identifier, account_type, enterprise_name, contact_name, password_hash, terms_agreed_at, status, roles, workspace_ids) VALUES ($1,$2,$3,'merchant',$4,$5,$6,now(),'active',ARRAY['merchant'], $7::text[])`, [accountId, identityId, login, input.enterpriseName.trim(), input.contactName.trim(), passwordHash, workspaceIds])
        await client.query(`INSERT INTO platform_identity_events (id,identity_id,event_type,actor_id,reason,evidence_json) VALUES ($1,$2,'auth.merchant_created',$3,$4,$5)`, [randomUUID(), identityId, input.actorId, input.reason.trim(), { account_type: 'merchant', workspace_ids: workspaceIds }])
        await this.syncEnterpriseName(client, workspaceIds, input.enterpriseName)
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw Object.assign(new Error('LOGIN_ALREADY_EXISTS'), { code: 'AUTH_LOGIN_ALREADY_EXISTS' })
        throw error
      }
      const account = await this.find(client, login)
      return this.public(account!)
    })
  }
  async listAccounts() { return this.withClient(async client => { const result = await client.query<AccountRecord>(`SELECT a.id, a.identity_id AS "identityId", a.login_identifier AS login, a.account_type AS "accountType", a.enterprise_name AS "enterpriseName", a.contact_name AS "contactName", a.password_hash AS "passwordHash", a.status, a.roles, a.workspace_ids AS "workspaceIds", a.failed_attempts AS "failedAttempts", a.locked_until AS "lockedUntil", a.auth_epoch AS "authEpoch", a.revision, a.created_at AS "createdAt", a.updated_at AS "updatedAt" FROM platform_password_accounts a ORDER BY a.updated_at DESC, a.id ASC`); return result.rows.map(row => this.public(row)) }) }
  async reviewMerchantRegistration(input: { login: string; decision: 'approved' | 'rejected'; workspaceIds?: string[]; actorId?: string; reason: string }) {
    const login = assertLogin(input.login)
    const workspaceIds = [...new Set((input.workspaceIds ?? []).map(value => value.trim()).filter(Boolean))]
    if (input.reason.trim().length < 4) throw Object.assign(new Error('AUTH_REGISTRATION_REVIEW_INVALID'), { code: 'AUTH_REGISTRATION_REVIEW_INVALID' })
    return this.withClient(async client => {
      // Binding a registration to a workspace is a tenant-boundary mutation.
      // Validate the complete target set in the same transaction as the
      // account transition so an approved account can never carry a stale,
      // disabled, or unknown workspace id into a later session projection.
      if (input.decision === 'approved') {
        const workspaces = await client.query<{ id: string }>(
          `SELECT id FROM workspaces WHERE id = ANY($1::text[]) AND status = 'active'`,
          [workspaceIds],
        )
        if (workspaces.rows.length !== workspaceIds.length) {
          throw Object.assign(new Error('WORKSPACE_NOT_FOUND'), { code: 'AUTH_WORKSPACE_NOT_FOUND' })
        }
      }
      const result = await client.query<any>(
        `UPDATE platform_password_accounts
            SET status=$2,
                workspace_ids=$3,
                revision=revision+1,
                updated_at=now()
          WHERE login_identifier=$1
            AND account_type='merchant'
            AND status='merchant_pending'
        RETURNING id,
                  identity_id AS "identityId",
                  login_identifier AS login,
                  account_type AS "accountType",
                  enterprise_name AS "enterpriseName",
                  contact_name AS "contactName",
                  password_hash AS "passwordHash",
                  status,
                  roles,
                  workspace_ids AS "workspaceIds",
                  failed_attempts AS "failedAttempts",
                  locked_until AS "lockedUntil",
                  auth_epoch AS "authEpoch",
                  revision,
                  created_at AS "createdAt",
                  updated_at AS "updatedAt"`,
        [login, input.decision === 'approved' ? 'active' : 'rejected', input.decision === 'approved' ? workspaceIds : []],
      )
      const account = result.rows[0] as AccountRecord | undefined
      if (!account) throw Object.assign(new Error('AUTH_REGISTRATION_STATE_INVALID'), { code: 'AUTH_REGISTRATION_STATE_INVALID' })
      await client.query(
        `INSERT INTO platform_identity_events (id,identity_id,event_type,actor_id,reason,evidence_json)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          randomUUID(),
          account.identityId,
          input.decision === 'approved' ? 'auth.merchant_activated' : 'auth.merchant_rejected',
          input.actorId?.trim() || 'system',
          input.reason.trim(),
          { workspace_ids: account.workspaceIds },
        ],
      )
      if (input.decision === 'approved') await this.syncEnterpriseName(client, workspaceIds, account.enterpriseName ?? '')
      return this.public(account)
    })
  }
  async ensurePlatformAccount(input: { login: string; passwordHash: string; roles?: string[] }) {
    const login = assertLogin(input.login)
    await this.withClient(async client => {
      const existing = await this.find(client, login)
      if (existing) return
      // A previous bootstrap can have committed the identity row before the
      // account insert failed. Reuse that identity instead of retrying a
      // conflicting INSERT and leaving the account permanently absent.
      const identityResult = await client.query<{ id: string }>(
        `INSERT INTO platform_identities (id, issuer, external_subject, display_name)
         VALUES ($1,'damai-password',$2,$2)
         ON CONFLICT (issuer, external_subject)
         DO UPDATE SET display_name = NULLIF(btrim(EXCLUDED.display_name), ''),
                       updated_at = now()
         RETURNING id`,
        [randomUUID(), login],
      )
      const identityId = identityResult.rows[0]?.id
      if (!identityId) throw new Error("PLATFORM_IDENTITY_BOOTSTRAP_FAILED")
      await client.query(
        `INSERT INTO platform_password_accounts
          (id,identity_id,login_identifier,account_type,password_hash,status,roles,workspace_ids)
         VALUES ($1,$2,$3,'platform',$4,'active',$5,ARRAY[]::text[])
         ON CONFLICT (login_identifier) DO NOTHING`,
        [randomUUID(), identityId, login, input.passwordHash, input.roles?.length ? input.roles : ['platform_admin']],
      )
    })
  }
  async activateMerchantAccount(input: { login: string; workspaceIds: string[]; actorId?: string; reason?: string }) { const login = assertLogin(input.login); return this.withClient(async client => { const workspaceIds = [...new Set(input.workspaceIds.map(value => value.trim()).filter(Boolean))]; const result = await client.query<any>(`UPDATE platform_password_accounts SET status='active', workspace_ids=$2, revision=revision+1, updated_at=now() WHERE login_identifier=$1 AND account_type='merchant' RETURNING id,identity_id AS "identityId",login_identifier AS login,account_type AS "accountType",enterprise_name AS "enterpriseName",contact_name AS "contactName",status,roles,workspace_ids AS "workspaceIds",failed_attempts AS "failedAttempts",locked_until AS "lockedUntil",revision,created_at AS "createdAt",updated_at AS "updatedAt"`, [login, workspaceIds]); const account = result.rows[0] as PasswordAccount | undefined; if (!account) throw Object.assign(new Error('AUTH_ACCOUNT_NOT_FOUND'), { code: 'AUTH_ACCOUNT_NOT_FOUND' }); await this.syncEnterpriseName(client, workspaceIds, account.enterpriseName ?? ''); await client.query(`INSERT INTO platform_identity_events (id,identity_id,event_type,actor_id,reason,before_json,after_json,evidence_json) VALUES ($1,$2,'auth.merchant_activated',$3,$4,$5,$6,$7)`, [randomUUID(), account.identityId, input.actorId?.trim() || 'system', input.reason?.trim() || 'merchant account activated', { status: 'merchant_pending' }, { account_type: account.accountType, status: account.status, workspace_ids: workspaceIds, revision: account.revision }, { source: 'password_auth_repository' }]); return this.public(account as AccountRecord) }) }
  async login(input: { login: string; password: string; ip?: string; userAgent?: string }) { const login = assertLogin(input.login); return this.withClient(async client => { const account = await this.find(client, login); const now = Date.now(); if (account?.lockedUntil && Date.parse(iso(account.lockedUntil)) > now) throw Object.assign(new Error('AUTH_ACCOUNT_LOCKED'), { code: 'AUTH_ACCOUNT_LOCKED' }); const valid = account ? await verifyPassword(account.passwordHash, input.password) : false; if (account && valid && account.status !== 'active') { await client.query(`INSERT INTO platform_identity_events (id,identity_id,event_type,actor_id,reason,evidence_json) VALUES ($1,$2,'auth.login_blocked',$3,'password authentication blocked for inactive account',$4)`, [randomUUID(), account.identityId, account.login, { status: account.status }]); throw Object.assign(new Error('AUTH_ACCOUNT_NOT_ACTIVE'), { code: 'AUTH_ACCOUNT_NOT_ACTIVE' }) } if (!account || !valid) { if (account) { const attempts = account.failedAttempts + 1; await client.query(`UPDATE platform_password_accounts SET failed_attempts=$2, locked_until=CASE WHEN $2>=5 THEN now()+interval '15 minutes' ELSE locked_until END, updated_at=now() WHERE id=$1`, [account.id, attempts]); await client.query(`INSERT INTO platform_identity_events (id,identity_id,event_type,actor_id,reason,evidence_json) VALUES ($1,$2,$3,$4,'password authentication failed',$5)`, [randomUUID(), account.identityId, attempts >= 5 ? 'auth.locked' : 'auth.login_failed', account.login, { attempts }]) } throw loginError() } await client.query(`UPDATE platform_password_accounts SET failed_attempts=0, locked_until=NULL, updated_at=now() WHERE id=$1`, [account.id]); const token = newOpaqueToken(); const issuedAt = new Date(now).toISOString(); const expiresAt = new Date(now + SESSION_MS).toISOString(); const sessionId = randomUUID(); await client.query(`INSERT INTO platform_password_sessions (id,account_id,token_hash,auth_epoch,issued_at,expires_at,ip_hash,user_agent_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [sessionId, account.id, tokenDigest(token), account.authEpoch, issuedAt, expiresAt, input.ip ? tokenDigest(input.ip) : null, input.userAgent ? tokenDigest(input.userAgent) : null]); // platform_identity_events.session_id references OIDC/API sessions only; password sessions are kept in evidence_json.
    await client.query(`INSERT INTO platform_identity_events (id,identity_id,event_type,actor_id,reason,evidence_json) VALUES ($1,$2,'auth.login_succeeded',$3,'password authentication succeeded',$4)`, [randomUUID(), account.identityId, account.login, { password_session_id: sessionId }]); return { token, principal: { account: this.public(account), sessionId, issuedAt, expiresAt } } }) }
  async authenticate(token: string) { return this.withClient(async client => { const result = await client.query<any>(`SELECT a.id,a.identity_id AS "identityId",a.login_identifier AS login,a.account_type AS "accountType",a.enterprise_name AS "enterpriseName",a.contact_name AS "contactName",a.status,a.roles,a.workspace_ids AS "workspaceIds",a.failed_attempts AS "failedAttempts",a.locked_until AS "lockedUntil",a.auth_epoch AS "authEpoch",i.auth_epoch AS "identityAuthEpoch",a.revision,a.created_at AS "createdAt",a.updated_at AS "updatedAt",s.id AS "sessionId",s.issued_at AS "issuedAt",s.expires_at AS "expiresAt",s.status AS "sessionStatus",s.auth_epoch AS "sessionAuthEpoch" FROM platform_password_sessions s JOIN platform_password_accounts a ON a.id=s.account_id JOIN platform_identities i ON i.id=a.identity_id WHERE s.token_hash=$1 FOR UPDATE`, [tokenDigest(token)]); const row = result.rows[0]; if (!row || row.sessionStatus !== 'active' || row.status !== 'active' || Number(row.authEpoch) !== Number(row.sessionAuthEpoch) || Number(row.identityAuthEpoch) !== Number(row.sessionAuthEpoch) || Date.parse(iso(row.expiresAt)) <= Date.now()) return undefined; return { account: row as PasswordAccount, sessionId: row.sessionId, issuedAt: iso(row.issuedAt), expiresAt: iso(row.expiresAt) } }) }
  async changePassword(input: { token: string; currentPassword: string; newPassword: string }) {
    try { validatePassword(input.newPassword) } catch (error) {
      if ((error as Error).message === 'PASSWORD_POLICY_INVALID') throw Object.assign(new Error('PASSWORD_POLICY_INVALID'), { code: 'AUTH_PASSWORD_POLICY_INVALID' })
      throw error
    }
    return this.withClient(async client => {
      const result = await client.query<any>(`SELECT a.id,a.identity_id AS "identityId",a.login_identifier AS login,a.password_hash AS "passwordHash",a.auth_epoch AS "authEpoch",s.id AS "sessionId",s.auth_epoch AS "sessionAuthEpoch",s.status AS "sessionStatus",s.expires_at AS "expiresAt" FROM platform_password_sessions s JOIN platform_password_accounts a ON a.id=s.account_id WHERE s.token_hash=$1 FOR UPDATE`, [tokenDigest(input.token)])
      const row = result.rows[0]
      if (!row || row.sessionStatus !== 'active' || Number(row.authEpoch) !== Number(row.sessionAuthEpoch) || Date.parse(iso(row.expiresAt)) <= Date.now()) throw Object.assign(new Error('AUTH_SESSION_INVALID'), { code: 'AUTH_SESSION_INVALID' })
      if (!(await verifyPassword(row.passwordHash, input.currentPassword))) throw Object.assign(new Error('AUTH_CURRENT_PASSWORD_INVALID'), { code: 'AUTH_CURRENT_PASSWORD_INVALID' })
      const hash = await hashPassword(input.newPassword)
      await client.query(`UPDATE platform_password_accounts SET password_hash=$2,auth_epoch=auth_epoch+1,failed_attempts=0,locked_until=NULL,revision=revision+1,updated_at=now() WHERE id=$1`, [row.id, hash])
      await client.query(`UPDATE platform_identities SET auth_epoch=auth_epoch+1,revision=revision+1,updated_at=now() WHERE id=$1`, [row.identityId])
      await client.query(`UPDATE platform_password_sessions SET status='revoked',revoked_at=now(),revoke_reason='password_changed' WHERE account_id=$1 AND status='active'`, [row.id])
      await client.query(`INSERT INTO platform_identity_events (id,identity_id,event_type,actor_id,reason,evidence_json) VALUES ($1,$2,'auth.password_changed',$3,'password changed',$4)`, [randomUUID(), row.identityId, row.login, { sessions_revoked: true }])
    })
  }
  async logout(token: string, reason = 'user_logout') { await this.withClient(async client => { const row = await client.query<{id:string;account_id:string;identity_id:string}>(`UPDATE platform_password_sessions s SET status='revoked',revoked_at=now(),revoke_reason=$2 FROM platform_password_accounts a WHERE s.account_id=a.id AND s.token_hash=$1 AND s.status='active' RETURNING s.id,a.identity_id`, [tokenDigest(token), reason]); if (row.rows[0]) await client.query(`INSERT INTO platform_identity_events (id,identity_id,event_type,actor_id,reason,evidence_json) VALUES ($1,$2,'auth.logout','system',$3,$4)`, [randomUUID(), row.rows[0].identity_id, reason, { password_session_id: row.rows[0].id }]) }) }
  async refresh(token: string) { const current = await this.authenticate(token); if (!current) throw Object.assign(new Error('AUTH_SESSION_INVALID'), { code: 'AUTH_SESSION_INVALID' }); await this.logout(token, 'session_refresh'); return this.withClient(async client => { const account = await this.find(client, current.account.login); if (!account) throw Object.assign(new Error('AUTH_SESSION_INVALID'), { code: 'AUTH_SESSION_INVALID' }); const raw = newOpaqueToken(); const issuedAt = new Date().toISOString(); const expiresAt = new Date(Date.now() + SESSION_MS).toISOString(); const sessionId = randomUUID(); await client.query(`INSERT INTO platform_password_sessions (id,account_id,token_hash,auth_epoch,issued_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6)`, [sessionId, account.id, tokenDigest(raw), account.authEpoch, issuedAt, expiresAt]); return { token: raw, principal: { account: this.public(account), sessionId, issuedAt, expiresAt } } }) }
  async requestPasswordReset(loginInput: string) { const login = normalizeLogin(loginInput); return this.withClient(async client => { const account = await this.find(client, login); if (!account) return { accepted: true as const }; const raw = newOpaqueToken(); await client.query(`INSERT INTO platform_password_reset_tokens (id,account_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '15 minutes')`, [randomUUID(), account.id, tokenDigest(raw)]); await client.query(`INSERT INTO platform_identity_events (id,identity_id,event_type,actor_id,reason) SELECT $1,identity_id,'auth.password_reset_requested',login_identifier,'password reset requested' FROM platform_password_accounts WHERE id=$2`, [randomUUID(), account.id]); return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true' ? { accepted: true as const, token: raw } : { accepted: true as const } }) }
  async confirmPasswordReset(token: string, password: string) { const hash = await hashPassword(password); await this.withClient(async client => { const row = await client.query<{id:string;account_id:string;identity_id:string}>(`UPDATE platform_password_reset_tokens SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING id,account_id,(SELECT identity_id FROM platform_password_accounts WHERE id=account_id) AS identity_id`, [tokenDigest(token)]); if (!row.rows[0]) throw Object.assign(new Error('AUTH_RESET_TOKEN_INVALID'), { code: 'AUTH_RESET_TOKEN_INVALID' }); await client.query(`UPDATE platform_password_accounts SET password_hash=$2,auth_epoch=auth_epoch+1,failed_attempts=0,locked_until=NULL,revision=revision+1,updated_at=now() WHERE id=$1`, [row.rows[0].account_id, hash]); await client.query(`UPDATE platform_identities SET auth_epoch=auth_epoch+1,revision=revision+1,updated_at=now() WHERE id=$1`, [row.rows[0].identity_id]); await client.query(`UPDATE platform_password_sessions SET status='revoked',revoked_at=now(),revoke_reason='password_reset' WHERE account_id=$1 AND status='active'`, [row.rows[0].account_id]); await client.query(`INSERT INTO platform_identity_events (id,identity_id,event_type,actor_id,reason,evidence_json) VALUES ($1,$2,'auth.password_reset_confirmed','system','password reset confirmed',$3)`, [randomUUID(), row.rows[0].identity_id, { sessions_revoked: true }]) }) }
  async issueMcpAuthorizationCode(input: McpOAuthContext & { account: PasswordAccount; redirectUri: string; codeChallenge: string }) {
    return this.withClient(async client => {
      const accountResult = await client.query<any>(`SELECT a.id,a.identity_id AS "identityId",a.login_identifier AS login,a.workspace_ids AS "workspaceIds",a.auth_epoch AS "accountAuthEpoch",i.auth_epoch AS "identityAuthEpoch",a.status,i.access_status AS "identityStatus",i.risk_decision AS "riskDecision" FROM platform_password_accounts a JOIN platform_identities i ON i.id=a.identity_id WHERE a.id=$1 AND a.identity_id=$2 AND a.account_type='merchant' FOR UPDATE OF a,i`, [input.account.id, input.account.identityId])
      const account = accountResult.rows[0]
      if (!account || account.status !== 'active' || account.identityStatus !== 'active' || account.riskDecision !== 'allow') throw mcpOAuthError('MCP_OAUTH_ACCOUNT_INVALID')
      const workspaceId = Array.isArray(account.workspaceIds) && account.workspaceIds.length === 1 ? account.workspaceIds[0] : undefined
      if (!workspaceId) throw mcpOAuthError('MCP_OAUTH_WORKSPACE_AMBIGUOUS')
      await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId])
      const memberResult = await client.query<any>(`SELECT m.id,m.workspace_id AS "workspaceId",m.identity_id AS "identityId" FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=$3 AND m.status='active' AND w.status='active' AND (m.identity_id=$1 OR (m.identity_id IS NULL AND m.external_subject=$2)) ORDER BY m.workspace_id FOR UPDATE OF m`, [account.identityId, account.login, workspaceId])
      if (memberResult.rows.length !== 1) throw mcpOAuthError('MCP_OAUTH_WORKSPACE_AMBIGUOUS')
      const member = memberResult.rows[0]
      if (!member.identityId) {
        const bound = await client.query(`UPDATE workspace_members SET identity_id=$2,revision=revision+1,updated_at=now() WHERE id=$1 AND identity_id IS NULL`, [member.id, account.identityId])
        if (bound.rowCount !== 1) throw mcpOAuthError('MCP_OAUTH_MEMBERSHIP_CONFLICT')
      }
      const code = newOpaqueToken(); const expiresAt = new Date(Date.now() + MCP_CODE_MS).toISOString()
      await client.query(`INSERT INTO mcp_oauth_authorization_codes (id,code_hash,client_id,redirect_uri,account_id,identity_id,workspace_id,code_challenge,scope,issuer,audience,resource,account_auth_epoch,identity_auth_epoch,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10,$11,$12,$13,$14,$15)`, [randomUUID(), tokenDigest(code), input.clientId, input.redirectUri, account.id, account.identityId, member.workspaceId, input.codeChallenge, input.scope, input.issuer, input.audience, input.resource, account.accountAuthEpoch, account.identityAuthEpoch, expiresAt])
      return { code, expiresAt, workspaceId: member.workspaceId as string }
    })
  }
  private async insertMcpTokenPair(client: SqlClient, input: McpOAuthContext & { accountId: string; identityId: string; workspaceId: string; accountAuthEpoch: number; identityAuthEpoch: number }, familyId: string = randomUUID()): Promise<McpOAuthTokenPair> {
    const now = new Date(); const accessToken = newOpaqueToken(); const refreshToken = newOpaqueToken(); const accessId = randomUUID(); const refreshId = randomUUID()
    await client.query(`INSERT INTO mcp_oauth_tokens (id,family_id,token_kind,token_hash,client_id,account_id,identity_id,workspace_id,scope,issuer,audience,resource,account_auth_epoch,identity_auth_epoch,issued_at,expires_at) VALUES ($1,$2,'access',$3,$4,$5,$6,$7,$8::text[],$9,$10,$11,$12,$13,$14,$15),($16,$2,'refresh',$17,$4,$5,$6,$7,$8::text[],$9,$10,$11,$12,$13,$14,$18)`, [accessId, familyId, tokenDigest(accessToken), input.clientId, input.accountId, input.identityId, input.workspaceId, input.scope, input.issuer, input.audience, input.resource, input.accountAuthEpoch, input.identityAuthEpoch, now.toISOString(), new Date(now.getTime() + MCP_ACCESS_MS).toISOString(), refreshId, tokenDigest(refreshToken), new Date(now.getTime() + MCP_REFRESH_MS).toISOString()])
    return { accessToken, refreshToken, expiresIn: MCP_ACCESS_MS / 1000, scope: [...input.scope] }
  }
  async exchangeMcpAuthorizationCode(input: McpOAuthContext & { redirectUri: string; code: string; codeVerifier: string }) {
    if (!validPkceVerifier(input.codeVerifier)) throw mcpOAuthError('MCP_OAUTH_INVALID_GRANT')
    return this.withClient(async client => {
      const result = await client.query<any>(`SELECT c.*,a.status AS account_status,a.auth_epoch AS current_account_auth_epoch,a.login_identifier,i.access_status AS identity_status,i.risk_decision,i.auth_epoch AS current_identity_auth_epoch,m.status AS member_status,w.status AS workspace_status FROM mcp_oauth_authorization_codes c JOIN platform_password_accounts a ON a.id=c.account_id JOIN platform_identities i ON i.id=c.identity_id JOIN workspace_members m ON m.workspace_id=c.workspace_id AND m.identity_id=c.identity_id JOIN workspaces w ON w.id=c.workspace_id WHERE c.code_hash=$1 FOR UPDATE OF c`, [tokenDigest(input.code)])
      const row = result.rows[0]
      const valid = row && !row.used_at && Date.parse(iso(row.expires_at)) > Date.now() && row.client_id === input.clientId && row.redirect_uri === input.redirectUri && row.issuer === input.issuer && row.audience === input.audience && row.resource === input.resource && Array.isArray(row.scope) && row.scope.includes('merchant') && row.code_challenge === pkceChallenge(input.codeVerifier) && row.account_status === 'active' && row.identity_status === 'active' && row.risk_decision === 'allow' && row.member_status === 'active' && row.workspace_status === 'active' && Number(row.account_auth_epoch) === Number(row.current_account_auth_epoch) && Number(row.identity_auth_epoch) === Number(row.current_identity_auth_epoch)
      if (!valid) throw mcpOAuthError('MCP_OAUTH_INVALID_GRANT')
      await client.query(`UPDATE mcp_oauth_authorization_codes SET used_at=now() WHERE id=$1 AND used_at IS NULL`, [row.id])
      return this.insertMcpTokenPair(client, { clientId: row.client_id, issuer: row.issuer, audience: row.audience, resource: row.resource, scope: row.scope, accountId: row.account_id, identityId: row.identity_id, workspaceId: row.workspace_id, accountAuthEpoch: Number(row.account_auth_epoch), identityAuthEpoch: Number(row.identity_auth_epoch) })
    })
  }
  async refreshMcpOAuthToken(input: McpOAuthContext & { refreshToken: string }) {
    const outcome = await this.withClient(async client => {
      const result = await client.query<any>(`SELECT t.*,a.status AS account_status,a.auth_epoch AS current_account_auth_epoch,a.login_identifier,i.access_status AS identity_status,i.risk_decision,i.auth_epoch AS current_identity_auth_epoch,m.status AS member_status,w.status AS workspace_status FROM mcp_oauth_tokens t JOIN platform_password_accounts a ON a.id=t.account_id JOIN platform_identities i ON i.id=t.identity_id JOIN workspace_members m ON m.workspace_id=t.workspace_id AND m.identity_id=t.identity_id JOIN workspaces w ON w.id=t.workspace_id WHERE t.token_hash=$1 AND t.token_kind='refresh' FOR UPDATE OF t`, [tokenDigest(input.refreshToken)])
      const row = result.rows[0]
      const valid = row && row.status === 'active' && Date.parse(iso(row.expires_at)) > Date.now() && row.client_id === input.clientId && row.issuer === input.issuer && row.audience === input.audience && row.resource === input.resource && Array.isArray(row.scope) && row.scope.includes('merchant') && row.account_status === 'active' && row.identity_status === 'active' && row.risk_decision === 'allow' && row.member_status === 'active' && row.workspace_status === 'active' && Number(row.account_auth_epoch) === Number(row.current_account_auth_epoch) && Number(row.identity_auth_epoch) === Number(row.current_identity_auth_epoch)
      if (!valid) {
        if (row?.family_id) await client.query(`UPDATE mcp_oauth_tokens SET status='revoked',revoked_at=now(),revoke_reason='refresh_replay_or_principal_invalid' WHERE family_id=$1 AND status='active'`, [row.family_id])
        return { error: true as const }
      }
      const pair = await this.insertMcpTokenPair(client, { clientId: row.client_id, issuer: row.issuer, audience: row.audience, resource: row.resource, scope: row.scope, accountId: row.account_id, identityId: row.identity_id, workspaceId: row.workspace_id, accountAuthEpoch: Number(row.account_auth_epoch), identityAuthEpoch: Number(row.identity_auth_epoch) }, row.family_id)
      const next = await client.query<{ id: string }>(`SELECT id FROM mcp_oauth_tokens WHERE token_hash=$1`, [tokenDigest(pair.refreshToken)])
      await client.query(`UPDATE mcp_oauth_tokens SET status='rotated',rotated_to_id=$2,revoked_at=now(),revoke_reason='refresh_rotated' WHERE id=$1 AND status='active'`, [row.id, next.rows[0]?.id])
      return { error: false as const, pair }
    })
    if (outcome.error) throw mcpOAuthError('MCP_OAUTH_INVALID_GRANT')
    return outcome.pair
  }
  async revokeMcpOAuthToken(input: McpOAuthContext & { token: string; tokenTypeHint?: 'access_token' | 'refresh_token' }) {
    await this.withClient(async client => {
      const result = await client.query<{ id: string; family_id: string; token_kind: 'access' | 'refresh' }>(
        `SELECT id,family_id,token_kind FROM mcp_oauth_tokens WHERE token_hash=$1 AND client_id=$2 AND issuer=$3 AND audience=$4 AND resource=$5 FOR UPDATE`,
        [tokenDigest(input.token), input.clientId, input.issuer, input.audience, input.resource],
      )
      const row = result.rows[0]
      // RFC 7009 defines token_type_hint as an optimization hint, not an
      // assertion about the token's actual type. The token hash remains the
      // authoritative lookup key so a mismatched hint cannot leave a token
      // active.
      if (!row) return
      if (row.token_kind === 'refresh') {
        await client.query(`UPDATE mcp_oauth_tokens SET status='revoked',revoked_at=now(),revoke_reason='oauth_token_revocation' WHERE family_id=$1 AND status='active'`, [row.family_id])
      } else {
        await client.query(`UPDATE mcp_oauth_tokens SET status='revoked',revoked_at=now(),revoke_reason='oauth_token_revocation' WHERE id=$1 AND status='active'`, [row.id])
      }
    })
  }
  async authenticateMcpAccessToken(input: McpOAuthContext & { accessToken: string }) {
    return this.withClient(async client => {
      const result = await client.query<any>(`SELECT t.id,t.identity_id AS "identityId",t.account_id AS "accountId",a.login_identifier AS "accountLogin",t.workspace_id AS "workspaceId",t.scope,t.issued_at AS "issuedAt",t.expires_at AS "expiresAt",t.status,a.status AS "accountStatus",a.auth_epoch AS "currentAccountAuthEpoch",t.account_auth_epoch AS "accountAuthEpoch",i.access_status AS "identityStatus",i.risk_decision AS "riskDecision",i.auth_epoch AS "currentIdentityAuthEpoch",t.identity_auth_epoch AS "identityAuthEpoch",m.status AS "memberStatus",w.status AS "workspaceStatus",t.client_id AS "clientId",t.issuer,t.audience,t.resource FROM mcp_oauth_tokens t JOIN platform_password_accounts a ON a.id=t.account_id JOIN platform_identities i ON i.id=t.identity_id JOIN workspace_members m ON m.workspace_id=t.workspace_id AND m.identity_id=t.identity_id JOIN workspaces w ON w.id=t.workspace_id WHERE t.token_hash=$1 AND t.token_kind='access'`, [tokenDigest(input.accessToken)])
      const row = result.rows[0]
      const valid = row && row.status === 'active' && Date.parse(iso(row.expiresAt)) > Date.now() && row.clientId === input.clientId && row.issuer === input.issuer && row.audience === input.audience && row.resource === input.resource && Array.isArray(row.scope) && input.scope.every(scope => row.scope.includes(scope)) && row.scope.includes('merchant') && row.accountStatus === 'active' && row.identityStatus === 'active' && row.riskDecision === 'allow' && row.memberStatus === 'active' && row.workspaceStatus === 'active' && Number(row.accountAuthEpoch) === Number(row.currentAccountAuthEpoch) && Number(row.identityAuthEpoch) === Number(row.currentIdentityAuthEpoch)
      if (!valid) return undefined
      return { identityId: row.identityId as string, accountId: row.accountId as string, accountLogin: row.accountLogin as string, workspaceId: row.workspaceId as string, scope: row.scope as string[], tokenId: row.id as string, issuedAt: iso(row.issuedAt), expiresAt: iso(row.expiresAt) }
    })
  }
}
