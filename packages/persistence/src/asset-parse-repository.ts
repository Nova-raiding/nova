import { randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export type AssetParseRecord =
  | { workspaceId: string; assetId: string; state: 'processing'; attempts: number; leaseToken: string; leaseUntil: string; retryable: true; updatedAt: string }
  | { workspaceId: string; assetId: string; state: 'succeeded'; attempts: number; facts: Record<string, unknown>; retryable: false; updatedAt: string }
  | { workspaceId: string; assetId: string; state: 'failed'; attempts: number; errorCode: string; errorMessage: string; retryable: boolean; updatedAt: string }

export class AssetParseRepositoryError extends Error {
  constructor(readonly code: 'ASSET_PARSE_BUSY' | 'ASSET_PARSE_LEASE_LOST' | 'ASSET_PARSE_ATTEMPTS_EXHAUSTED' | 'ASSET_PARSE_ALREADY_SUCCEEDED' | 'ASSET_PARSE_EMPTY') {
    super(code)
    this.name = 'AssetParseRepositoryError'
  }
}

export interface AssetParseRepository {
  claim(input: { workspaceId: string; assetId: string; leaseMs: number; maxAttempts?: number; now?: string }): Promise<Extract<AssetParseRecord, { state: 'processing' }>>
  succeed(input: { workspaceId: string; assetId: string; leaseToken: string; facts: Record<string, unknown>; now?: string }): Promise<Extract<AssetParseRecord, { state: 'succeeded' }>>
  fail(input: { workspaceId: string; assetId: string; leaseToken: string; errorCode: string; errorMessage: string; retryable: boolean; now?: string }): Promise<Extract<AssetParseRecord, { state: 'failed' }>>
  expire(input: { workspaceId: string; assetId: string; leaseToken: string; now?: string }): Promise<Extract<AssetParseRecord, { state: 'failed' }>>
  confirm(input: { workspaceId: string; assetId: string; facts: Record<string, unknown>; now?: string }): Promise<Extract<AssetParseRecord, { state: 'succeeded' }>>
  get(input: { workspaceId: string; assetId: string }): Promise<AssetParseRecord | undefined>
}

const MAX_ID_LENGTH = 255
const MAX_LEASE_MS = 24 * 60 * 60 * 1000
const MAX_ATTEMPTS = 1_000
const keyOf = (workspaceId: string, assetId: string) => `${workspaceId}\0${assetId}`

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`ASSET_PARSE_${label}_REQUIRED`)
  const normalized = value.trim()
  if (!normalized || normalized.length > MAX_ID_LENGTH || /[\u0000-\u001F\u007F]/u.test(normalized)) throw new Error(`ASSET_PARSE_${label}_REQUIRED`)
  return normalized
}

function workspace(value: string): string {
  return identifier(requireWorkspaceScope(value), 'WORKSPACE_ID')
}

function positive(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError(`${label} must be a positive integer no greater than ${maximum}`)
  return value
}

function instant(value?: string): number {
  if (value === undefined) return Date.now()
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) throw new RangeError('asset parse timestamp must be a canonical UTC instant')
  const time = Date.parse(value)
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new RangeError('asset parse timestamp is invalid')
  return time
}

function nonEmptyFacts(value: Record<string, unknown>): { facts: Record<string, unknown>; json: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AssetParseRepositoryError('ASSET_PARSE_EMPTY')
  try {
    const json = JSON.stringify(value)
    if (!json) throw new AssetParseRepositoryError('ASSET_PARSE_EMPTY')
    const facts = JSON.parse(json) as unknown
    if (!facts || typeof facts !== 'object' || Array.isArray(facts) || Object.keys(facts).length === 0) throw new AssetParseRepositoryError('ASSET_PARSE_EMPTY')
    return { facts: facts as Record<string, unknown>, json }
  } catch (error) {
    if (error instanceof AssetParseRepositoryError) throw error
    throw new AssetParseRepositoryError('ASSET_PARSE_EMPTY')
  }
}

export class MemoryAssetParseRepository implements AssetParseRepository {
  private readonly rows = new Map<string, AssetParseRecord>()

  async claim(input: { workspaceId: string; assetId: string; leaseMs: number; maxAttempts?: number; now?: string }) {
    const workspaceId = workspace(input.workspaceId)
    const assetId = identifier(input.assetId, 'ASSET_ID')
    const leaseMs = positive(input.leaseMs, 'leaseMs', MAX_LEASE_MS)
    const maxAttempts = positive(input.maxAttempts ?? 3, 'maxAttempts', MAX_ATTEMPTS)
    const now = instant(input.now)
    const key = keyOf(workspaceId, assetId)
    const current = this.rows.get(key)

    if (current?.state === 'succeeded') throw new AssetParseRepositoryError('ASSET_PARSE_ALREADY_SUCCEEDED')
    if (current?.state === 'processing' && Date.parse(current.leaseUntil) > now) throw new AssetParseRepositoryError('ASSET_PARSE_BUSY')
    if (current?.state === 'failed' && !current.retryable) throw new AssetParseRepositoryError('ASSET_PARSE_ATTEMPTS_EXHAUSTED')
    if ((current?.attempts ?? 0) >= maxAttempts) {
      if (current?.state === 'processing' || (current?.state === 'failed' && current.retryable)) this.rows.set(key, terminalExhausted(workspaceId, assetId, current.attempts, now))
      throw new AssetParseRepositoryError('ASSET_PARSE_ATTEMPTS_EXHAUSTED')
    }

    const row = Object.freeze({
      workspaceId,
      assetId,
      state: 'processing' as const,
      attempts: (current?.attempts ?? 0) + 1,
      leaseToken: `asset_parse_${randomUUID()}`,
      leaseUntil: new Date(now + leaseMs).toISOString(),
      retryable: true as const,
      updatedAt: new Date(now).toISOString(),
    })
    this.rows.set(key, row)
    return row
  }

  async succeed(input: { workspaceId: string; assetId: string; leaseToken: string; facts: Record<string, unknown>; now?: string }) {
    const workspaceId = workspace(input.workspaceId)
    const assetId = identifier(input.assetId, 'ASSET_ID')
    const leaseToken = identifier(input.leaseToken, 'LEASE_TOKEN')
    const { facts } = nonEmptyFacts(input.facts)
    const now = instant(input.now)
    const key = keyOf(workspaceId, assetId)
    const current = this.rows.get(key)
    if (current?.state !== 'processing' || current.leaseToken !== leaseToken || Date.parse(current.updatedAt) > now || Date.parse(current.leaseUntil) <= now) throw new AssetParseRepositoryError('ASSET_PARSE_LEASE_LOST')

    const row = Object.freeze({ workspaceId, assetId, state: 'succeeded' as const, attempts: current.attempts, facts, retryable: false as const, updatedAt: new Date(now).toISOString() })
    this.rows.set(key, row)
    return row
  }

  async fail(input: { workspaceId: string; assetId: string; leaseToken: string; errorCode: string; errorMessage: string; retryable: boolean; now?: string }) {
    const workspaceId = workspace(input.workspaceId)
    const assetId = identifier(input.assetId, 'ASSET_ID')
    const leaseToken = identifier(input.leaseToken, 'LEASE_TOKEN')
    const errorCode = identifier(input.errorCode, 'ERROR_CODE')
    const errorMessage = identifier(input.errorMessage, 'ERROR_MESSAGE')
    const now = instant(input.now)
    const key = keyOf(workspaceId, assetId)
    const current = this.rows.get(key)
    if (current?.state !== 'processing' || current.leaseToken !== leaseToken || Date.parse(current.updatedAt) > now || Date.parse(current.leaseUntil) <= now) throw new AssetParseRepositoryError('ASSET_PARSE_LEASE_LOST')

    const row = Object.freeze({ workspaceId, assetId, state: 'failed' as const, attempts: current.attempts, errorCode, errorMessage, retryable: input.retryable, updatedAt: new Date(now).toISOString() })
    this.rows.set(key, row)
    return row
  }

  async expire(input: { workspaceId: string; assetId: string; leaseToken: string; now?: string }) {
    const workspaceId = workspace(input.workspaceId)
    const assetId = identifier(input.assetId, 'ASSET_ID')
    const leaseToken = identifier(input.leaseToken, 'LEASE_TOKEN')
    const now = instant(input.now)
    const key = keyOf(workspaceId, assetId)
    const current = this.rows.get(key)
    if (current?.state !== 'processing' || current.leaseToken !== leaseToken || Date.parse(current.updatedAt) > now || Date.parse(current.leaseUntil) > now) throw new AssetParseRepositoryError('ASSET_PARSE_LEASE_LOST')

    const row = Object.freeze({ workspaceId, assetId, state: 'failed' as const, attempts: current.attempts, errorCode: 'ASSET_PARSE_TIMEOUT', errorMessage: 'asset parse timed out', retryable: true, updatedAt: new Date(now).toISOString() })
    this.rows.set(key, row)
    return row
  }

  async confirm(input: { workspaceId: string; assetId: string; facts: Record<string, unknown>; now?: string }) {
    const workspaceId = workspace(input.workspaceId)
    const assetId = identifier(input.assetId, 'ASSET_ID')
    const { facts } = nonEmptyFacts(input.facts)
    const now = instant(input.now)
    const key = keyOf(workspaceId, assetId)
    const current = this.rows.get(key)
    const row = Object.freeze({ workspaceId, assetId, state: 'succeeded' as const, attempts: Math.max(1, current?.attempts ?? 0), facts, retryable: false as const, updatedAt: new Date(now).toISOString() })
    this.rows.set(key, row)
    return row
  }

  async get(input: { workspaceId: string; assetId: string }) {
    return this.rows.get(keyOf(workspace(input.workspaceId), identifier(input.assetId, 'ASSET_ID')))
  }
}

type Row = {
  workspace_id: string
  asset_id: string
  state: 'processing' | 'succeeded' | 'failed'
  attempts: number
  lease_token: string | null
  lease_until: string | Date | null
  facts: Record<string, unknown> | null
  error_code: string | null
  error_message: string | null
  retryable: boolean
  updated_at: string | Date
}

type ClaimOutcome =
  | { kind: 'claimed'; row: Row }
  | { kind: 'busy' | 'succeeded' | 'exhausted' }

const projection = 'workspace_id,asset_id,state,attempts,lease_token,lease_until,facts,error_code,error_message,retryable,updated_at'
const iso = (value: string | Date) => value instanceof Date ? value.toISOString() : String(value)

function terminalExhausted(workspaceId: string, assetId: string, attempts: number, now: number): Extract<AssetParseRecord, { state: 'failed' }> {
  return Object.freeze({ workspaceId, assetId, state: 'failed', attempts, errorCode: 'ASSET_PARSE_ATTEMPTS_EXHAUSTED', errorMessage: 'asset parse lease expired at the retry limit', retryable: false, updatedAt: new Date(now).toISOString() })
}

function map(row: Row): AssetParseRecord {
  const base = { workspaceId: row.workspace_id, assetId: row.asset_id, attempts: row.attempts, updatedAt: iso(row.updated_at) }
  if (row.state === 'processing') return { ...base, state: 'processing', leaseToken: row.lease_token!, leaseUntil: iso(row.lease_until!), retryable: true }
  if (row.state === 'succeeded') return { ...base, state: 'succeeded', facts: row.facts!, retryable: false }
  return { ...base, state: 'failed', errorCode: row.error_code!, errorMessage: row.error_message!, retryable: row.retryable }
}

export class PostgresAssetParseRepository implements AssetParseRepository {
  constructor(private readonly pool: SqlPool) {}

  async claim(input: { workspaceId: string; assetId: string; leaseMs: number; maxAttempts?: number; now?: string }) {
    const workspaceId = workspace(input.workspaceId)
    const assetId = identifier(input.assetId, 'ASSET_ID')
    const leaseMs = positive(input.leaseMs, 'leaseMs', MAX_LEASE_MS)
    const maxAttempts = positive(input.maxAttempts ?? 3, 'maxAttempts', MAX_ATTEMPTS)
    const now = new Date(instant(input.now)).toISOString()
    const token = `asset_parse_${randomUUID()}`

    const outcome = await withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const claimed = await client.query<Row>(`
        INSERT INTO asset_parse_leases (workspace_id,asset_id,state,attempts,lease_token,lease_until,retryable,updated_at)
        VALUES ($1,$2,'processing',1,$3,$4::timestamptz + ($5 * interval '1 millisecond'),TRUE,$4)
        ON CONFLICT (workspace_id,asset_id) DO UPDATE SET
          state='processing', attempts=asset_parse_leases.attempts+1, lease_token=EXCLUDED.lease_token,
          lease_until=EXCLUDED.lease_until, facts=NULL, error_code=NULL, error_message=NULL,
          retryable=TRUE, updated_at=EXCLUDED.updated_at
        WHERE asset_parse_leases.attempts < $6
          AND asset_parse_leases.updated_at <= $4
          AND ((asset_parse_leases.state='processing' AND asset_parse_leases.lease_until <= $4)
            OR (asset_parse_leases.state='failed' AND asset_parse_leases.retryable))
        RETURNING ${projection}
      `, [workspaceId, assetId, token, now, leaseMs, maxAttempts])
      if (claimed.rows[0]) return { kind: 'claimed', row: claimed.rows[0] } satisfies ClaimOutcome

      const current = await client.query<Row>(`SELECT ${projection} FROM asset_parse_leases WHERE workspace_id=$1 AND asset_id=$2 FOR UPDATE`, [workspaceId, assetId])
      const row = current.rows[0]
      if (row?.state === 'succeeded') return { kind: 'succeeded' } satisfies ClaimOutcome
      if (row?.state === 'processing' && row.lease_until && Date.parse(iso(row.lease_until)) > Date.parse(now)) return { kind: 'busy' } satisfies ClaimOutcome
      if (row && ((row.state === 'processing' && row.lease_until && Date.parse(iso(row.lease_until)) <= Date.parse(now)) || (row.state === 'failed' && row.retryable)) && row.attempts >= maxAttempts) {
        await client.query(`
          UPDATE asset_parse_leases
          SET state='failed', lease_token=NULL, lease_until=NULL, facts=NULL,
            error_code='ASSET_PARSE_ATTEMPTS_EXHAUSTED', error_message='asset parse lease expired at the retry limit',
            retryable=FALSE, updated_at=$3
          WHERE workspace_id=$1 AND asset_id=$2 AND attempts >= $4
            AND updated_at <= $3
            AND ((state='processing' AND lease_until <= $3) OR (state='failed' AND retryable))
        `, [workspaceId, assetId, now, maxAttempts])
      }
      return { kind: 'exhausted' } satisfies ClaimOutcome
    })

    if (outcome.kind === 'claimed') return map(outcome.row) as Extract<AssetParseRecord, { state: 'processing' }>
    if (outcome.kind === 'succeeded') throw new AssetParseRepositoryError('ASSET_PARSE_ALREADY_SUCCEEDED')
    if (outcome.kind === 'busy') throw new AssetParseRepositoryError('ASSET_PARSE_BUSY')
    throw new AssetParseRepositoryError('ASSET_PARSE_ATTEMPTS_EXHAUSTED')
  }

  async succeed(input: { workspaceId: string; assetId: string; leaseToken: string; facts: Record<string, unknown>; now?: string }) {
    const workspaceId = workspace(input.workspaceId)
    const assetId = identifier(input.assetId, 'ASSET_ID')
    const leaseToken = identifier(input.leaseToken, 'LEASE_TOKEN')
    const { json } = nonEmptyFacts(input.facts)
    const now = new Date(instant(input.now)).toISOString()
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const result = await client.query<Row>(`
        UPDATE asset_parse_leases
        SET state='succeeded', lease_token=NULL, lease_until=NULL, facts=$4::jsonb,
          error_code=NULL, error_message=NULL, retryable=FALSE, updated_at=$5
        WHERE workspace_id=$1 AND asset_id=$2 AND state='processing' AND lease_token=$3
          AND lease_until>$5 AND updated_at<=$5
        RETURNING ${projection}
      `, [workspaceId, assetId, leaseToken, json, now])
      if (!result.rows[0]) throw new AssetParseRepositoryError('ASSET_PARSE_LEASE_LOST')
      return map(result.rows[0]) as Extract<AssetParseRecord, { state: 'succeeded' }>
    })
  }

  async fail(input: { workspaceId: string; assetId: string; leaseToken: string; errorCode: string; errorMessage: string; retryable: boolean; now?: string }) {
    const workspaceId = workspace(input.workspaceId)
    const assetId = identifier(input.assetId, 'ASSET_ID')
    const leaseToken = identifier(input.leaseToken, 'LEASE_TOKEN')
    const errorCode = identifier(input.errorCode, 'ERROR_CODE')
    const errorMessage = identifier(input.errorMessage, 'ERROR_MESSAGE')
    const now = new Date(instant(input.now)).toISOString()
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const result = await client.query<Row>(`
        UPDATE asset_parse_leases
        SET state='failed', lease_token=NULL, lease_until=NULL, facts=NULL,
          error_code=$4, error_message=$5, retryable=$6, updated_at=$7
        WHERE workspace_id=$1 AND asset_id=$2 AND state='processing' AND lease_token=$3
          AND lease_until>$7 AND updated_at<=$7
        RETURNING ${projection}
      `, [workspaceId, assetId, leaseToken, errorCode, errorMessage, input.retryable, now])
      if (!result.rows[0]) throw new AssetParseRepositoryError('ASSET_PARSE_LEASE_LOST')
      return map(result.rows[0]) as Extract<AssetParseRecord, { state: 'failed' }>
    })
  }

  async expire(input: { workspaceId: string; assetId: string; leaseToken: string; now?: string }) {
    const workspaceId = workspace(input.workspaceId)
    const assetId = identifier(input.assetId, 'ASSET_ID')
    const leaseToken = identifier(input.leaseToken, 'LEASE_TOKEN')
    const now = new Date(instant(input.now)).toISOString()
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const result = await client.query<Row>(`
        UPDATE asset_parse_leases
        SET state='failed', lease_token=NULL, lease_until=NULL, facts=NULL,
          error_code='ASSET_PARSE_TIMEOUT', error_message='asset parse timed out',
          retryable=TRUE, updated_at=$4
        WHERE workspace_id=$1 AND asset_id=$2 AND state='processing' AND lease_token=$3
          AND lease_until<=$4 AND updated_at<=$4
        RETURNING ${projection}
      `, [workspaceId, assetId, leaseToken, now])
      if (!result.rows[0]) throw new AssetParseRepositoryError('ASSET_PARSE_LEASE_LOST')
      return map(result.rows[0]) as Extract<AssetParseRecord, { state: 'failed' }>
    })
  }

  async confirm(input: { workspaceId: string; assetId: string; facts: Record<string, unknown>; now?: string }) {
    const workspaceId = workspace(input.workspaceId)
    const assetId = identifier(input.assetId, 'ASSET_ID')
    const { json } = nonEmptyFacts(input.facts)
    const now = new Date(instant(input.now)).toISOString()
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const result = await client.query<Row>(`
        INSERT INTO asset_parse_leases
          (workspace_id,asset_id,state,attempts,lease_token,lease_until,facts,error_code,error_message,retryable,updated_at)
        VALUES ($1,$2,'succeeded',1,NULL,NULL,$3::jsonb,NULL,NULL,FALSE,$4)
        ON CONFLICT (workspace_id,asset_id) DO UPDATE SET
          state='succeeded', lease_token=NULL, lease_until=NULL, facts=EXCLUDED.facts,
          error_code=NULL, error_message=NULL, retryable=FALSE, updated_at=EXCLUDED.updated_at
        RETURNING ${projection}
      `, [workspaceId, assetId, json, now])
      return map(result.rows[0]!) as Extract<AssetParseRecord, { state: 'succeeded' }>
    })
  }

  async get(input: { workspaceId: string; assetId: string }) {
    const workspaceId = workspace(input.workspaceId)
    const assetId = identifier(input.assetId, 'ASSET_ID')
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const result = await client.query<Row>(`SELECT ${projection} FROM asset_parse_leases WHERE workspace_id=$1 AND asset_id=$2`, [workspaceId, assetId])
      return result.rows[0] ? map(result.rows[0]) : undefined
    })
  }
}
