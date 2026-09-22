import { randomUUID } from 'node:crypto'
import type { SqlClient, SqlPool } from './repository.js'

export type LocalPluginConnectionStatus = 'pending' | 'authorized' | 'exchanged' | 'expired'

export interface LocalPluginConnectionRequest {
  id: string
  accountId: string
  identityId: string
  workspaceId: string
  status: LocalPluginConnectionStatus
  createdAt: string
  expiresAt: string
  authorizedAt?: string
  exchangedAt?: string
}

export interface LocalPluginConnectionRepository {
  create(input: { accountId: string; identityId: string; workspaceId: string }): Promise<LocalPluginConnectionRequest>
  getForAccount(input: { id: string; accountId: string; workspaceId: string }): Promise<LocalPluginConnectionRequest | undefined>
  authorize(input: { id: string; accountId: string; identityId: string; workspaceId: string }): Promise<LocalPluginConnectionRequest>
  markExchanged(input: { id: string; accountId: string; workspaceId: string }): Promise<LocalPluginConnectionRequest>
}

export class LocalPluginConnectionError extends Error {
  readonly code = 'LOCAL_PLUGIN_CONNECTION_INVALID'
  constructor() { super('local plugin connection request is invalid, expired, or already consumed') }
}

const copy = (record: LocalPluginConnectionRequest): LocalPluginConnectionRequest => ({ ...record })

/** Test and local adapter. Mutations contain no await between validation and the
 * state write, preserving the same compare-and-set semantics as the SQL adapter. */
export class MemoryLocalPluginConnectionRepository implements LocalPluginConnectionRepository {
  private readonly records = new Map<string, LocalPluginConnectionRequest>()
  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = 5 * 60_000) {}

  private current(record: LocalPluginConnectionRequest): LocalPluginConnectionRequest {
    if (record.status !== 'exchanged' && Date.parse(record.expiresAt) <= this.now()) record.status = 'expired'
    return record
  }

  async create(input: { accountId: string; identityId: string; workspaceId: string }) {
    const now = this.now()
    for (const existing of this.records.values()) if (existing.accountId === input.accountId && existing.workspaceId === input.workspaceId && (existing.status === 'pending' || existing.status === 'authorized')) existing.status = 'expired'
    const record: LocalPluginConnectionRequest = { id: randomUUID(), ...input, status: 'pending', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + this.ttlMs).toISOString() }
    this.records.set(record.id, record)
    return copy(record)
  }

  async getForAccount(input: { id: string; accountId: string; workspaceId: string }) {
    const record = this.records.get(input.id)
    if (!record || record.accountId !== input.accountId || record.workspaceId !== input.workspaceId) return undefined
    return copy(this.current(record))
  }

  async authorize(input: { id: string; accountId: string; identityId: string; workspaceId: string }) {
    const record = this.records.get(input.id)
    if (!record || record.accountId !== input.accountId || record.identityId !== input.identityId || record.workspaceId !== input.workspaceId || this.current(record).status !== 'pending') throw new LocalPluginConnectionError()
    record.status = 'authorized'; record.authorizedAt = new Date(this.now()).toISOString()
    return copy(record)
  }

  async markExchanged(input: { id: string; accountId: string; workspaceId: string }) {
    const record = this.records.get(input.id)
    if (!record || record.accountId !== input.accountId || record.workspaceId !== input.workspaceId || this.current(record).status !== 'authorized') throw new LocalPluginConnectionError()
    record.status = 'exchanged'; record.exchangedAt = new Date(this.now()).toISOString()
    return copy(record)
  }
}

type ConnectionRow = { id: string; account_id: string; identity_id: string; workspace_id: string; status: LocalPluginConnectionStatus; created_at: Date | string; expires_at: Date | string; authorized_at: Date | string | null; exchanged_at: Date | string | null }
const fromRow = (row: ConnectionRow): LocalPluginConnectionRequest => ({ id: row.id, accountId: row.account_id, identityId: row.identity_id, workspaceId: row.workspace_id, status: row.status, createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString(), ...(row.authorized_at ? { authorizedAt: new Date(row.authorized_at).toISOString() } : {}), ...(row.exchanged_at ? { exchangedAt: new Date(row.exchanged_at).toISOString() } : {}) })
const projection = 'id,account_id,identity_id,workspace_id,status,created_at,expires_at,authorized_at,exchanged_at'

export class PostgresLocalPluginConnectionRepository implements LocalPluginConnectionRepository {
  constructor(private readonly pool: SqlPool) {}
  private async tx<T>(fn: (client: SqlClient) => Promise<T>) { const client = await this.pool.connect(); try { await client.query('BEGIN'); await client.query(`SELECT set_config('app.platform_scope','platform_ops',true)`); const result = await fn(client); await client.query('COMMIT'); return result } catch (error) { try { await client.query('ROLLBACK') } catch {} throw error } finally { client.release?.() } }
  private async audit(client: SqlClient, record: LocalPluginConnectionRequest, eventType: string) { await client.query(`INSERT INTO platform_identity_events (id,identity_id,event_type,actor_id,reason,evidence_json) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`, [randomUUID(), record.identityId, eventType, record.accountId, 'local plugin connection lifecycle', JSON.stringify({ request_id: record.id, workspace_id: record.workspaceId, status: record.status })]) }
  async create(input: { accountId: string; identityId: string; workspaceId: string }) { return this.tx(async client => { const superseded = await client.query<ConnectionRow>(`UPDATE local_plugin_connection_requests SET status='expired' WHERE account_id=$1 AND workspace_id=$2 AND status IN ('pending','authorized') RETURNING ${projection}`, [input.accountId, input.workspaceId]); for (const row of superseded.rows) await this.audit(client, fromRow(row), 'auth.local_plugin_connection_superseded'); const result = await client.query<ConnectionRow>(`INSERT INTO local_plugin_connection_requests (id,account_id,identity_id,workspace_id,expires_at) VALUES ($1,$2,$3,$4,now()+interval '5 minutes') RETURNING ${projection}`, [randomUUID(), input.accountId, input.identityId, input.workspaceId]); const record = fromRow(result.rows[0]!); await this.audit(client, record, 'auth.local_plugin_connection_created'); return record }) }
  async getForAccount(input: { id: string; accountId: string; workspaceId: string }) { return this.tx(async client => { const expired = await client.query<ConnectionRow>(`UPDATE local_plugin_connection_requests SET status='expired' WHERE id=$1 AND account_id=$2 AND workspace_id=$3 AND status IN ('pending','authorized') AND expires_at<=now() RETURNING ${projection}`, [input.id, input.accountId, input.workspaceId]); if (expired.rows[0]) await this.audit(client, fromRow(expired.rows[0]), 'auth.local_plugin_connection_expired'); const result = await client.query<ConnectionRow>(`SELECT ${projection} FROM local_plugin_connection_requests WHERE id=$1 AND account_id=$2 AND workspace_id=$3`, [input.id, input.accountId, input.workspaceId]); return result.rows[0] ? fromRow(result.rows[0]) : undefined }) }
  async authorize(input: { id: string; accountId: string; identityId: string; workspaceId: string }) { return this.tx(async client => { const result = await client.query<ConnectionRow>(`UPDATE local_plugin_connection_requests SET status='authorized',authorized_at=now() WHERE id=$1 AND account_id=$2 AND identity_id=$3 AND workspace_id=$4 AND status='pending' AND expires_at>now() RETURNING ${projection}`, [input.id, input.accountId, input.identityId, input.workspaceId]); if (!result.rows[0]) throw new LocalPluginConnectionError(); const record = fromRow(result.rows[0]); await this.audit(client, record, 'auth.local_plugin_connection_authorized'); return record }) }
  async markExchanged(input: { id: string; accountId: string; workspaceId: string }) { return this.tx(async client => { const result = await client.query<ConnectionRow>(`UPDATE local_plugin_connection_requests SET status='exchanged',exchanged_at=now() WHERE id=$1 AND account_id=$2 AND workspace_id=$3 AND status='authorized' AND expires_at>now() RETURNING ${projection}`, [input.id, input.accountId, input.workspaceId]); if (!result.rows[0]) throw new LocalPluginConnectionError(); const record = fromRow(result.rows[0]); await this.audit(client, record, 'auth.local_plugin_connection_exchanged'); return record }) }
}
