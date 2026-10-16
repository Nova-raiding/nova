import { describe, expect, it } from 'vitest'
import { PostgresAssetScanRedriveRepository, type AssetScanRedriveInput } from './asset-scan-redrive-repository.js'
import type { SqlClient } from './repository.js'

const asset = {
  id: 'asset_scan', workspaceId: 'ws_scan', revision: 1, sourceRevision: 1,
  storageKey: 'quarantine/ws_scan/asset_scan/source.png', sha256: 'a'.repeat(64),
  sizeBytes: 12, mimeType: 'image/png', scanStatus: 'quarantined',
}
const input: AssetScanRedriveInput = {
  workspaceId: 'ws_scan', assetId: asset.id, deadLetterOutboxEventId: 'evt_scan', expectedAssetRevision: 1,
  recoveryKey: 'recovery-scan-once', actorId: 'operator', reason: 'scanner recovered', scanMaxAttempts: 12,
  authorizationSnapshot: {
    schema_version: 1, decision_id: 'decision', actor_id: 'operator', workspace_id: 'ws_scan',
    context_id: 'workspace:ws_scan', context_version: 'ctx_1', policy_version: 'policy_1', grant_revision: 'grant_1',
    scope_hash: 'b'.repeat(64), capability: 'asset.scan.execute', resource_id: asset.id, authorized: true,
    decided_at: '2026-09-07T00:00:00.000Z',
  },
  commercialAccessSnapshot: {
    schema_version: 1, decision_id: 'commercial-decision', workspace_id: 'ws_scan', operation: 'asset.scan.execute',
    access_mode: 'POINT_REQUIRED_NO_CHARGE', access_revision: '1', balance_state: 'known',
    entitlement_snapshot_id: 'creative-point-access:ws_scan:1', entitlement_snapshot_checksum: 'c'.repeat(64),
    rate_version: null, quoted_points: 0, decided_at: '2026-09-07T00:00:00.000Z',
  },
}
const failure = { code: 'CLAMAV_SCAN_ERROR', message: 'scanner unavailable', retryable: true, terminal: true }
const event = {
  id: input.deadLetterOutboxEventId, workspace_id: input.workspaceId, aggregate_id: asset.id,
  event_type: 'asset.uploaded', sequence: 1,
  payload: { asset_id: asset.id, storage_key: asset.storageKey, sha256: asset.sha256, size_bytes: asset.sizeBytes, source_revision: 1 },
  published_at: null, unknown_at: null, lease_token: null, lease_until: null, attempts: 12, last_error: failure,
}

class ReadOnlyClient implements SqlClient {
  readonly statements: string[] = []
  constructor(private readonly oldEvent: Record<string, unknown>) {}
  async query<T = Record<string, unknown>>(sql: string) {
    this.statements.push(sql)
    if (/^(?:INSERT|UPDATE|DELETE)/u.test(sql)) throw new Error('invalid redrive attempted a write')
    const rows = sql.includes('FROM business_entity_snapshots') ? [{ entity_version: 1, payload: asset }]
      : sql.includes('FROM outbox_events') ? [this.oldEvent] : []
    return { rows: rows as T[] }
  }
  release() {}
}

describe('asset scan redrive terminal admission', () => {
  it.each([
    ['retry still pending', { last_error: { ...failure, terminal: false } }],
    ['missing terminal marker', { last_error: { code: failure.code, message: failure.message, retryable: true } }],
    ['string terminal marker', { last_error: { ...failure, terminal: 'true' } }],
    ['unknown outcome', { unknown_at: '2026-09-07T00:00:00.000Z' }],
    ['active worker lease', { lease_token: 'lease_worker', lease_until: '2099-09-07T00:00:00.000Z' }],
    ['expired unreleased worker lease', { lease_token: 'lease_worker', lease_until: '2020-09-07T00:00:00.000Z' }],
    ['orphaned lease deadline', { lease_until: '2020-09-07T00:00:00.000Z' }],
    ['attempt budget not exhausted', { attempts: 11 }],
    ['unrecoverable failure', { last_error: { ...failure, code: 'ASSET_MALWARE_DETECTED', retryable: false } }],
    ['published without failure evidence', { published_at: '2026-09-07T00:00:00.000Z', last_error: null }],
  ] satisfies Array<[string, Record<string, unknown>]> )('rejects %s before any write', async (_name, override) => {
    const client = new ReadOnlyClient({ ...event, ...override })
    const repository = new PostgresAssetScanRedriveRepository({ connect: async () => client })
    await expect(repository.redrive(input)).rejects.toMatchObject({ code: 'ASSET_SCAN_REDRIVE_NOT_DEAD_LETTER' })
    expect(client.statements).toContain('ROLLBACK')
    expect(client.statements.some(sql => /^(?:INSERT|UPDATE|DELETE)/u.test(sql))).toBe(false)
  })
})

describe('historical scan bootstrap recovery boundaries', () => {
  it('lists a terminal bootstrap failure for the same recovery path as uploaded assets', async () => {
    const client: SqlClient = {
      async query<T = Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
        const allowed = values?.[1] as string[] | undefined
        const rows = sql.includes('FROM outbox_events o JOIN') && allowed?.includes('asset.scan_bootstrap_requested')
          ? [{ ...event, event_type: 'asset.scan_bootstrap_requested', asset_revision: 1, asset_payload: asset }] : []
        return { rows: rows as T[] }
      },
      release() {},
    }
    const repo = new PostgresAssetScanRedriveRepository({ connect: async () => client })
    await expect(repo.listRetryableFailures(input.workspaceId, { scanMaxAttempts: 12 })).resolves.toMatchObject([
      { assetId: asset.id, event: { eventType: 'asset.scan_bootstrap_requested' }, failure: { retryable: true } },
    ])
  })

  it('admits a bound terminal bootstrap event through the existing redrive checks', async () => {
    const client = new ReadOnlyClient({ ...event, event_type: 'asset.scan_bootstrap_requested' })
    const repo = new PostgresAssetScanRedriveRepository({ connect: async () => client })
    // This read-only probe deliberately stops at the first write: it verifies
    // event admission, not a committed SQL transaction or worker execution.
    await expect(repo.redrive(input)).rejects.toThrow('invalid redrive attempted a write')
    expect(client.statements.some(sql => sql.startsWith('UPDATE business_entity_snapshots'))).toBe(true)
    expect(client.statements).toContain('ROLLBACK')
  })

  it.each([
    ['missing auth', { authorizationSnapshot: undefined }],
    ['wrong actor', { authorizationSnapshot: { ...input.authorizationSnapshot, actor_id: 'other' } }],
    ['wrong context', { authorizationSnapshot: { ...input.authorizationSnapshot, context_id: 'workspace:foreign' } }],
    ['invalid scope digest', { authorizationSnapshot: { ...input.authorizationSnapshot, scope_hash: 'invalid' } }],
    ['missing decision', { authorizationSnapshot: { ...input.authorizationSnapshot, decision_id: '' } }],
    ['invalid auth timestamp', { authorizationSnapshot: { ...input.authorizationSnapshot, decided_at: 'invalid' } }],
    ['missing commercial', { commercialAccessSnapshot: undefined }],
    ['unverified balance', { commercialAccessSnapshot: { ...input.commercialAccessSnapshot, balance_state: 'unknown' } }],
    ['wrong commercial mode', { commercialAccessSnapshot: { ...input.commercialAccessSnapshot, access_mode: 'FREE' } }],
    ['invalid entitlement digest', { commercialAccessSnapshot: { ...input.commercialAccessSnapshot, entitlement_snapshot_checksum: 'invalid' } }],
  ])('rejects %s before opening a transaction', async (_name, patch) => {
    let connections = 0
    const repo = new PostgresAssetScanRedriveRepository({ connect: async () => { connections += 1; throw new Error('unexpected connection') } })
    await expect(repo.bootstrapUnscanned({ ...input, ...patch } as unknown as Parameters<typeof repo.bootstrapUnscanned>[0])).rejects.toMatchObject({ code: 'ASSET_SCAN_BOOTSTRAP_INPUT_INVALID' })
    expect(connections).toBe(0)
  })
})
