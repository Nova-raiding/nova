import { randomUUID } from 'node:crypto'
import { createHash, randomBytes } from 'node:crypto'
import argon2 from 'argon2'
import type { SqlClient, SqlPool } from './repository.js'

const newOpaqueToken = (bytes = 32) => randomBytes(bytes).toString('base64url')
const tokenDigest = (token: string) => createHash('sha256').update(token).digest('hex')
const normalizeLogin = (value: string) => value.trim().toLowerCase()
const validatePassword = (password: string) => { if (typeof password !== 'string' || password.length < 12 || password.length > 256 || !/[A-Za-z]/u.test(password) || !/[0-9]/u.test(password)) throw new Error('PASSWORD_POLICY_INVALID') }
const hashPassword = async (password: string) => { validatePassword(password); return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 }) }
const verifyPassword = async (hash: string, password: string) => { if (!hash || typeof password !== 'string' || password.length > 256) return false; try { return await argon2.verify(hash, password) } catch { return false } }

export type PasswordAccountType = 'merchant' | 'platform'
export type PasswordAccountStatus = 'merchant_pending' | 'active' | 'suspended' | 'revoked'
export interface PasswordAccount {
  id: string
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
export interface PasswordAuthRepository {
  register(input: { login: string; password: string; enterpriseName: string; contactName: string; termsAgreed: boolean }): Promise<{ account: PasswordAccount; applicationId: string }>
  login(input: { login: string; password: string; ip?: string; userAgent?: string }): Promise<{ token: string; principal: PasswordSessionPrincipal }>
  authenticate(token: string): Promise<PasswordSessionPrincipal | undefined>
  logout(token: string, reason?: string): Promise<void>
  refresh(token: string): Promise<{ token: string; principal: PasswordSessionPrincipal }>
  requestPasswordReset(login: string): Promise<{ accepted: true; token?: string }>
  confirmPasswordReset(token: string, password: string): Promise<void>
  ensurePlatformAccount(input: { login: string; passwordHash: string; roles?: string[] }): Promise<void>
}

type AccountRecord = PasswordAccount & { passwordHash: string; authEpoch: number }
type SessionRecord = PasswordSessionPrincipal & { tokenHash: string; authEpoch: number; status: 'active' | 'revoked' }
type ResetRecord = { accountId: string; tokenHash: string; expiresAt: number; used: boolean }

const GENERIC_LOGIN_ERROR = '账号或密码错误'
const LOCK_MS = 15 * 60_000
const SESSION_MS = 8 * 60 * 60_000
const RESET_MS = 15 * 60_000
const loginError = () => Object.assign(new Error(GENERIC_LOGIN_ERROR), { code: 'AUTH_INVALID_CREDENTIALS' })
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
  readonly events: Array<Record<string, unknown>> = []

  async register(input: { login: string; password: string; enterpriseName: string; contactName: string; termsAgreed: boolean }) {
    const login = assertRegistration(input)
    if (this.accounts.has(login)) throw Object.assign(new Error('LOGIN_ALREADY_EXISTS'), { code: 'AUTH_LOGIN_ALREADY_EXISTS' })
    let passwordHash: string
    try { passwordHash = await hashPassword(input.password) } catch (error) { if ((error as Error).message === 'PASSWORD_POLICY_INVALID') throw Object.assign(new Error('PASSWORD_POLICY_INVALID'), { code: 'AUTH_PASSWORD_POLICY_INVALID' }); throw error }
    const now = new Date().toISOString()
    const account: AccountRecord = { id: randomUUID(), login, accountType: 'merchant', enterpriseName: input.enterpriseName.trim(), contactName: input.contactName.trim(), status: 'merchant_pending', roles: ['merchant'], workspaceIds: [], failedAttempts: 0, revision: 1, authEpoch: 1, createdAt: now, updatedAt: now, passwordHash }
    this.accounts.set(login, account)
    auditMemory(this.events, 'auth.registered', account.id, { account_type: account.accountType, status: account.status })
    return { account: accountPublic(account), applicationId: account.id }
  }

  async ensurePlatformAccount(input: { login: string; passwordHash: string; roles?: string[] }) {
    const login = assertLogin(input.login)
    const existing = this.accounts.get(login)
    if (existing) return
    const now = new Date().toISOString()
    this.accounts.set(login, { id: randomUUID(), login, accountType: 'platform', status: 'active', roles: input.roles?.length ? [...new Set(input.roles)] : ['platform_admin'], workspaceIds: [], failedAttempts: 0, revision: 1, authEpoch: 1, createdAt: now, updatedAt: now, passwordHash: input.passwordHash })
    auditMemory(this.events, 'auth.platform_preseeded', login, { account_type: 'platform' })
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
  async logout(token: string, reason = 'user_logout') { const session = this.sessions.get(tokenDigest(token)); if (session && session.status === 'active') { session.status = 'revoked'; auditMemory(this.events, 'auth.logout', session.account.id, { session_id: session.sessionId, reason }) } }
  async refresh(token: string) { const current = await this.authenticate(token); if (!current) throw Object.assign(new Error('AUTH_SESSION_INVALID'), { code: 'AUTH_SESSION_INVALID' }); await this.logout(token, 'session_refresh'); const account = this.accounts.get(current.account.login)!; const raw = newOpaqueToken(); const now = Date.now(); const session: SessionRecord = { tokenHash: tokenDigest(raw), sessionId: randomUUID(), account: accountPublic(account), issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + SESSION_MS).toISOString(), authEpoch: account.authEpoch, status: 'active' }; this.sessions.set(session.tokenHash, session); auditMemory(this.events, 'auth.refresh', account.id, { session_id: session.sessionId }); return { token: raw, principal: { account: session.account, sessionId: session.sessionId, issuedAt: session.issuedAt, expiresAt: session.expiresAt } } }
  async requestPasswordReset(loginInput: string) { const login = normalizeLogin(loginInput); const account = this.accounts.get(login); if (!account) return { accepted: true as const }; const token = newOpaqueToken(32); this.resets.set(tokenDigest(token), { accountId: account.id, tokenHash: tokenDigest(token), expiresAt: Date.now() + RESET_MS, used: false }); auditMemory(this.events, 'auth.password_reset_requested', account.id); return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true' ? { accepted: true as const, token } : { accepted: true as const } }
  async confirmPasswordReset(token: string, password: string) { const record = this.resets.get(tokenDigest(token)); if (!record || record.used || record.expiresAt <= Date.now()) throw Object.assign(new Error('AUTH_RESET_TOKEN_INVALID'), { code: 'AUTH_RESET_TOKEN_INVALID' }); const account = [...this.accounts.values()].find(item => item.id === record.accountId)!; account.passwordHash = await hashPassword(password); account.authEpoch += 1; account.failedAttempts = 0; account.lockedUntil = undefined; account.revision += 1; account.updatedAt = new Date().toISOString(); record.used = true; for (const session of this.sessions.values()) if (session.account.id === account.id) session.status = 'revoked'; auditMemory(this.events, 'auth.password_reset_confirmed', account.id, { sessions_revoked: true }) }
}

/** PostgreSQL adapter. All auth tables live in the isolated control-plane
 * database role; only digests and Argon2id hashes are persisted. */
export class PostgresPasswordAuthRepository implements PasswordAuthRepository {
  constructor(private readonly pool: SqlPool) {}
  private async withClient<T>(fn: (client: SqlClient) => Promise<T>) { const client = await this.pool.connect(); try { await client.query('BEGIN'); await client.query(`SELECT set_config('app.platform_scope', 'platform_ops', true)`); const value = await fn(client); await client.query('COMMIT'); return value } catch (error) { try { await client.query('ROLLBACK') } catch {} throw error } finally { client.release?.() } }
  private async find(client: SqlClient, login: string) { const result = await client.query<any>(`SELECT id, login_identifier AS login, account_type AS "accountType", enterprise_name AS "enterpriseName", contact_name AS "contactName", status, roles, workspace_ids AS "workspaceIds", password_hash AS "passwordHash", failed_attempts AS "failedAttempts", locked_until AS "lockedUntil", auth_epoch AS "authEpoch", revision, created_at AS "createdAt", updated_at AS "updatedAt" FROM platform_password_accounts WHERE login_identifier=$1`, [login]); return result.rows[0] as AccountRecord | undefined }
  private public(account: AccountRecord) { return accountPublic({ ...account, createdAt: iso(account.createdAt), updatedAt: iso(account.updatedAt) }) }
  async register(input: { login: string; password: string; enterpriseName: string; contactName: string; termsAgreed: boolean }) { const login = assertRegistration(input); const passwordHash = await hashPassword(input.password); return this.withClient(async client => { const identityId = randomUUID(); const applicationId = randomUUID(); try { await client.query(`INSERT INTO platform_identities (id, issuer, external_subject, display_name) VALUES ($1,'damai-password',$2,$3)`, [identityId, login, input.contactName.trim()]); await client.query(`INSERT INTO platform_password_accounts (id, identity_id, login_identifier, account_type, enterprise_name, contact_name, password_hash, terms_agreed_at, status, roles, workspace_ids) VALUES ($1,$2,$3,'merchant',$4,$5,$6,now(),'merchant_pending',ARRAY['merchant'],ARRAY[]::text[])`, [applicationId, identityId, login, input.enterpriseName.trim(), input.contactName.trim(), passwordHash]); await client.query(`INSERT INTO platform_identity_events (id,identity_id,event_type,actor_id,reason,evidence_json) VALUES ($1,$2,'auth.registered',$3,'merchant registration',$4)`, [randomUUID(), identityId, login, { account_type: 'merchant', status: 'merchant_pending' }]) } catch (error) { if ((error as { code?: string }).code === '23505') throw Object.assign(new Error('LOGIN_ALREADY_EXISTS'), { code: 'AUTH_LOGIN_ALREADY_EXISTS' }); throw error } const account = await this.find(client, login); return { account: this.public(account!), applicationId } }) }
  async ensurePlatformAccount(input: { login: string; passwordHash: string; roles?: string[] }) { const login = assertLogin(input.login); await this.withClient(async client => { const existing = await this.find(client, login); if (existing) return; const identityId = randomUUID(); await client.query(`INSERT INTO platform_identities (id, issuer, external_subject, display_name) VALUES ($1,'damai-password',$2,$2)`, [identityId, login]); await client.query(`INSERT INTO platform_password_accounts (id,identity_id,login_identifier,account_type,password_hash,status,roles,workspace_ids) VALUES ($1,$2,$3,'platform',$4,'active',$5,ARRAY[]::text[])`, [randomUUID(), identityId, login, input.passwordHash, input.roles?.length ? input.roles : ['platform_admin']]) }) }
  async login(input: { login: string; password: string; ip?: string; userAgent?: string }) { const login = assertLogin(input.login); return this.withClient(async client => { const account = await this.find(client, login); const now = Date.now(); if (account?.lockedUntil && Date.parse(iso(account.lockedUntil)) > now) throw Object.assign(new Error('AUTH_ACCOUNT_LOCKED'), { code: 'AUTH_ACCOUNT_LOCKED' }); const valid = account ? await verifyPassword(account.passwordHash, input.password) : false; if (!account || !valid) { if (account) { const attempts = account.failedAttempts + 1; await client.query(`UPDATE platform_password_accounts SET failed_attempts=$2, locked_until=CASE WHEN $2>=5 THEN now()+interval '15 minutes' ELSE locked_until END, updated_at=now() WHERE id=$1`, [account.id, attempts]); await client.query(`INSERT INTO platform_identity_events (id,identity_id,event_type,actor_id,reason,evidence_json) VALUES ($1,$2,$3,$4,'password authentication failed',$5)`, [randomUUID(), account.id, attempts >= 5 ? 'auth.locked' : 'auth.login_failed', account.login, { attempts }]) } throw loginError() } await client.query(`UPDATE platform_password_accounts SET failed_attempts=0, locked_until=NULL, updated_at=now() WHERE id=$1`, [account.id]); const token = newOpaqueToken(); const issuedAt = new Date(now).toISOString(); const expiresAt = new Date(now + SESSION_MS).toISOString(); const sessionId = randomUUID(); await client.query(`INSERT INTO platform_password_sessions (id,account_id,token_hash,auth_epoch,issued_at,expires_at,ip_hash,user_agent_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [sessionId, account.id, tokenDigest(token), account.authEpoch, issuedAt, expiresAt, input.ip ? tokenDigest(input.ip) : null, input.userAgent ? tokenDigest(input.userAgent) : null]); await client.query(`INSERT INTO platform_identity_events (id,identity_id,session_id,event_type,actor_id,reason,evidence_json) SELECT $1,identity_id,'${sessionId}'::uuid,'auth.login_succeeded',login_identifier,'password authentication succeeded',$2 FROM platform_password_accounts WHERE id=$3`, [randomUUID(), { session_id: sessionId }, account.id]); return { token, principal: { account: this.public(account), sessionId, issuedAt, expiresAt } } }) }
  async authenticate(token: string) { return this.withClient(async client => { const result = await client.query<any>(`SELECT a.id,a.login_identifier AS login,a.account_type AS "accountType",a.enterprise_name AS "enterpriseName",a.contact_name AS "contactName",a.status,a.roles,a.workspace_ids AS "workspaceIds",a.failed_attempts AS "failedAttempts",a.locked_until AS "lockedUntil",a.auth_epoch AS "authEpoch",a.revision,a.created_at AS "createdAt",a.updated_at AS "updatedAt",s.id AS "sessionId",s.issued_at AS "issuedAt",s.expires_at AS "expiresAt",s.status AS "sessionStatus" FROM platform_password_sessions s JOIN platform_password_accounts a ON a.id=s.account_id WHERE s.token_hash=$1 FOR UPDATE`, [tokenDigest(token)]); const row = result.rows[0]; if (!row || row.sessionStatus !== 'active' || row.status !== 'active' || Number(row.authEpoch) !== Number((await client.query<{auth_epoch:number}>(`SELECT auth_epoch FROM platform_identities WHERE id=(SELECT identity_id FROM platform_password_accounts WHERE id=$1)`, [row.id])).rows[0]?.auth_epoch ?? row.authEpoch) || Date.parse(iso(row.expiresAt)) <= Date.now()) return undefined; return { account: row as PasswordAccount, sessionId: row.sessionId, issuedAt: iso(row.issuedAt), expiresAt: iso(row.expiresAt) } }) }
  async logout(token: string, reason = 'user_logout') { await this.withClient(async client => { const row = await client.query<{id:string;account_id:string;identity_id:string}>(`UPDATE platform_password_sessions s SET status='revoked',revoked_at=now(),revoke_reason=$2 FROM platform_password_accounts a WHERE s.account_id=a.id AND s.token_hash=$1 AND s.status='active' RETURNING s.id,a.identity_id`, [tokenDigest(token), reason]); if (row.rows[0]) await client.query(`INSERT INTO platform_identity_events (id,identity_id,session_id,event_type,actor_id,reason) VALUES ($1,$2,$3,'auth.logout','system',$4)`, [randomUUID(), row.rows[0].identity_id, row.rows[0].id, reason]) }) }
  async refresh(token: string) { const current = await this.authenticate(token); if (!current) throw Object.assign(new Error('AUTH_SESSION_INVALID'), { code: 'AUTH_SESSION_INVALID' }); await this.logout(token, 'session_refresh'); return this.withClient(async client => { const account = await this.find(client, current.account.login); if (!account) throw Object.assign(new Error('AUTH_SESSION_INVALID'), { code: 'AUTH_SESSION_INVALID' }); const raw = newOpaqueToken(); const issuedAt = new Date().toISOString(); const expiresAt = new Date(Date.now() + SESSION_MS).toISOString(); const sessionId = randomUUID(); await client.query(`INSERT INTO platform_password_sessions (id,account_id,token_hash,auth_epoch,issued_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6)`, [sessionId, account.id, tokenDigest(raw), account.authEpoch, issuedAt, expiresAt]); return { token: raw, principal: { account: this.public(account), sessionId, issuedAt, expiresAt } } }) }
  async requestPasswordReset(loginInput: string) { const login = normalizeLogin(loginInput); return this.withClient(async client => { const account = await this.find(client, login); if (!account) return { accepted: true as const }; const raw = newOpaqueToken(); await client.query(`INSERT INTO platform_password_reset_tokens (id,account_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '15 minutes')`, [randomUUID(), account.id, tokenDigest(raw)]); await client.query(`INSERT INTO platform_identity_events (id,identity_id,event_type,actor_id,reason) SELECT $1,identity_id,'auth.password_reset_requested',login_identifier,'password reset requested' FROM platform_password_accounts WHERE id=$2`, [randomUUID(), account.id]); return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true' ? { accepted: true as const, token: raw } : { accepted: true as const } }) }
  async confirmPasswordReset(token: string, password: string) { const hash = await hashPassword(password); await this.withClient(async client => { const row = await client.query<{id:string;account_id:string;identity_id:string}>(`UPDATE platform_password_reset_tokens SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING id,account_id,(SELECT identity_id FROM platform_password_accounts WHERE id=account_id) AS identity_id`, [tokenDigest(token)]); if (!row.rows[0]) throw Object.assign(new Error('AUTH_RESET_TOKEN_INVALID'), { code: 'AUTH_RESET_TOKEN_INVALID' }); await client.query(`UPDATE platform_password_accounts SET password_hash=$2,auth_epoch=auth_epoch+1,failed_attempts=0,locked_until=NULL,revision=revision+1,updated_at=now() WHERE id=$1`, [row.rows[0].account_id, hash]); await client.query(`UPDATE platform_password_sessions SET status='revoked',revoked_at=now(),revoke_reason='password_reset' WHERE account_id=$1 AND status='active'`, [row.rows[0].account_id]); await client.query(`INSERT INTO platform_identity_events (id,identity_id,event_type,actor_id,reason,evidence_json) VALUES ($1,$2,'auth.password_reset_confirmed','system','password reset confirmed',$3)`, [randomUUID(), row.rows[0].identity_id, { sessions_revoked: true }]) }) }
}
