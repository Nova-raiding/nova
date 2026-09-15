import { describe, expect, it } from 'vitest'
import { CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS, isValidCustomerDeliveryContractRef, MemoryCustomerDeliveryRepository, PostgresCustomerDeliveryRepository } from './customer-delivery-repository.js'
import type { SqlClient, SqlPool } from './repository.js'
import type { CustomerDelivery, CustomerDeliveryPatch } from './customer-delivery-repository.js'

class RecordingClient implements SqlClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []
  private readonly responses: Array<{ rows: Record<string, unknown>[] }> = []
  preflight?: { parent: Record<string, unknown>; videos?: Record<string, unknown>[]; items?: Record<string, unknown>[] }
  enqueue(...rows: Record<string, unknown>[]) { this.responses.push({ rows }) }
  async query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values })
    // Preflight is additional read-only work; retain the original body FIFO so
    // its persisted before/after audit snapshots still have independent values.
    if (text.includes('delivery_evidence_preflight_parent') || text.includes('delivery_evidence_recheck */'))
      return { rows: this.preflight ? [this.preflight.parent] : this.responses[0]?.rows ?? [] } as { rows: T[] }
    if (text.includes('delivery_evidence_preflight_videos') || text.includes('delivery_evidence_recheck_videos'))
      return { rows: this.preflight?.videos ?? [] } as { rows: T[] }
    if (text.includes('delivery_evidence_preflight_items') || text.includes('delivery_evidence_recheck_items'))
      return { rows: this.preflight?.items ?? [] } as { rows: T[] }
    if (text.includes('assert_customer_delivery_evidence_asset')) return { rows: [] as T[] }
    return (this.responses.shift() ?? { rows: [] }) as { rows: T[] }
  }
  release() {}
}

class RecordingPool implements SqlPool {
  constructor(readonly client: RecordingClient) {}
  async connect() { return this.client }
}

class RejectingVideoEvidenceClient extends RecordingClient {
  override async query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    if (text.includes('assert_customer_delivery_evidence_asset') && values?.[2] === 'video') {
      this.calls.push({ text, values })
      throw new Error('blocked or unbound evidence asset')
    }
    return super.query<T>(text, values)
  }
}

// Repository-only references below are not trusted scan fixtures. Asset existence,
// upload transport and signed scanner receipts belong to separate API/runtime tests.
async function completeChecklist(repo: MemoryCustomerDeliveryRepository, delivery: CustomerDelivery, checklistKey: 'system_integration' | 'functional_acceptance') {
  await repo.updateChecklistItems({ workspaceId: delivery.workspaceId, deliveryId: delivery.id,
    actorId: 'operator-1', checklistKey, expectedRevision: delivery.revision,
    items: CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS[checklistKey].map(itemKey => ({ itemKey, completed: true,
      evidence: { note: `repository reference ${itemKey}`, asset_refs: [`asset_${checklistKey}_${itemKey}`] } })),
  })
  return (await repo.get(delivery.workspaceId, delivery.id))!
}

const profile = {
  contractNumber: 'C-1', contractRef: 'asset_ref_repository_only_contract',
  projectOwner: 'owner', supportOwner: 'support', plannedGoLiveAt: '2026-10-01',
  customerProfileStatus: 'complete' as const,
}

function legacyRow(repo: MemoryCustomerDeliveryRepository, delivery: CustomerDelivery) {
  // Model a <=200 stored row, without manufacturing scan metadata.
  const rows = (repo as unknown as { rows: Map<string, CustomerDelivery> }).rows
  const legacy: CustomerDelivery = { ...delivery, ...profile, paymentStatus: 'paid', paymentDate: '2026-09-14',
    paymentEvidenceRefs: [], trainingCompleted: true, trainingEvidenceRefs: [],
    systemIntegrationStatus: 'complete', functionalAcceptanceStatus: 'complete',
    effectiveAt: '2026-09-13T00:00:00.000Z' }
  rows.set(`${delivery.workspaceId}:${delivery.id}`, legacy)
  return legacy
}

function postgresRow(overrides: Record<string, unknown> = {}) {
  return { id: 'cd_pg', workspace_id: 'ws_pg', company_name: 'PG Co', contract_number: 'C-1',
    contract_ref: 'asset_ref_repository_contract', project_owner: 'owner', support_owner: 'support',
    payment_status: 'paid', payment_date: '2026-09-14', payment_evidence_refs: ['asset_payment'],
    planned_go_live_at: '2026-10-01T00:00:00.000Z', customer_profile_status: 'complete',
    system_integration_status: 'complete', functional_acceptance_status: 'complete', training_completed: true,
    training_evidence_refs: ['asset_training'], effective_at: null, revision: 4,
    created_by_actor_id: 'operator-1', updated_by_actor_id: 'operator-1',
    created_at: '2026-09-14T00:00:00.000Z', updated_at: '2026-09-14T00:00:00.000Z', ...overrides }
}

function postgresVideo(id = 'video_1', assetRef = 'asset_video') {
  return { id, workspace_id: 'ws_pg', delivery_id: 'cd_pg', title: 'Repository reference only',
    asset_ref: assetRef, sort_order: 0, uploaded_by_actor_id: 'operator-1',
    created_at: '2026-09-14T00:00:00.000Z', deleted_at: null }
}

function postgresItems() {
  return Object.entries(CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS).flatMap(([checklistKey, keys]) => keys.map((itemKey, index) => ({
    workspace_id: 'ws_pg', delivery_id: 'cd_pg', checklist_key: checklistKey, item_key: String(itemKey), completed: true,
    evidence: { asset_refs: [`asset_${checklistKey}_${index}`] }, completed_by_actor_id: 'operator-1',
    completed_at: '2026-09-14T00:00:00.000Z', updated_at: '2026-09-14T00:00:00.000Z', revision: 1,
  })))
}

type TestDbRow = Record<string, any>

// SQL protocol double, not a PostgreSQL/scan simulator. It rejects unknown SQL
// and models only the repository's transaction boundary and row-shaped results.
class EvidenceTransactionClient extends RecordingClient {
  row: TestDbRow = postgresRow()
  videos: TestDbRow[] = [postgresVideo()]
  items: TestDbRow[] = postgresItems()
  audits: readonly unknown[][] = []
  revisionChanges = 0
  blockedAssets = new Set<string>()
  queryFailures = new Map<string, Error>()
  assertionFailure?: Error
  auditFailure?: Error
  lockedBodyChange?: (client: EvidenceTransactionClient) => void
  recheckChange?: (client: EvidenceTransactionClient) => void
  private snapshot?: { row: TestDbRow; videos: TestDbRow[]; items: TestDbRow[]; audits: readonly unknown[][] }

  private state() {
    return structuredClone({ row: this.row, videos: this.videos, items: this.items, audits: this.audits })
  }

  override async query<T = Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
    this.calls.push({ text, values })
    for (const [marker, failure] of this.queryFailures) if (text.includes(marker)) throw failure
    const result = (rows: TestDbRow[] = []) => ({ rows: structuredClone(rows) as T[] })
    if (text === 'BEGIN') { this.snapshot = this.state(); return result() }
    if (text === 'COMMIT') { this.snapshot = undefined; return result() }
    if (text === 'ROLLBACK') {
      if (this.snapshot) Object.assign(this, this.snapshot)
      this.snapshot = undefined
      return result()
    }
    if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) /u.test(text)) return result()
    if (text.includes("set_config('app.workspace_id'")) return result()
    if (text.includes('assert_customer_delivery_evidence_asset')) {
      if (this.assertionFailure) throw this.assertionFailure
      if (this.blockedAssets.has(String(values[3]))) throw new Error('blocked or unbound evidence asset')
      return result()
    }
    if (text.includes('delivery_evidence_recheck */') || text.includes('delivery_evidence_read_recheck */')) {
      if (this.revisionChanges > 0) {
        this.revisionChanges--
        this.row.revision++
        // This revision belongs to another committed writer, not the attempt
        // being rolled back. Preserve it in our rollback baseline.
        this.snapshot!.row.revision = this.row.revision
      }
      if (this.recheckChange) {
        const change = this.recheckChange
        this.recheckChange = undefined
        change(this)
        this.snapshot = this.state()
      }
    }
    if (text.startsWith('SELECT') && text.includes('FROM workspace_customer_deliveries')) {
      if (text.includes('delivery_evidence_list_ids'))
        return result(this.row.workspace_id === values[0] ? [{ id: this.row.id }] : [])
      if (text.includes('FOR UPDATE') && !text.includes('delivery_evidence_recheck') && this.lockedBodyChange) {
        const change = this.lockedBodyChange
        this.lockedBodyChange = undefined
        change(this)
      }
      return result(this.row.workspace_id === values[0] && this.row.id === values[1] ? [this.row] : [])
    }
    if (text.startsWith('SELECT') && text.includes('FROM workspace_customer_delivery_videos')) {
      const deliveryIds = Array.isArray(values[1]) ? values[1] : [values[1]]
      return result(this.videos.filter(video => video.workspace_id === values[0]
        && deliveryIds.includes(video.delivery_id) && !video.deleted_at))
    }
    if (text.startsWith('SELECT') && text.includes('FROM workspace_customer_delivery_checklist_items')) {
      const deliveryIds = Array.isArray(values[1]) ? values[1] : [values[1]]
      return result(this.items.filter(item => item.workspace_id === values[0] && deliveryIds.includes(item.delivery_id)
        && (values[2] === undefined || item.checklist_key === values[2])
        && (values[3] === undefined || (Array.isArray(values[3]) ? values[3].includes(item.item_key) : item.item_key === values[3]))))
    }
    if (text.startsWith('INSERT INTO workspace_customer_delivery_checklist_items')) {
      const index = this.items.findIndex(item => item.workspace_id === values[0] && item.delivery_id === values[1]
        && item.checklist_key === values[2] && item.item_key === values[3])
      const saved = { workspace_id: values[0], delivery_id: values[1], checklist_key: values[2], item_key: values[3],
        completed: values[4], evidence: JSON.parse(String(values[5])), completed_by_actor_id: values[6],
        completed_at: values[4] ? this.row.updated_at : null, revision: (this.items[index]?.revision ?? 0) + 1,
        updated_at: this.row.updated_at }
      if (index < 0) this.items.push(saved)
      else this.items[index] = saved
      return result([saved])
    }
    if (text.startsWith('INSERT INTO workspace_customer_delivery_videos')) {
      const video = { ...postgresVideo(), id: values[0], workspace_id: values[1], delivery_id: values[2], title: values[3],
        asset_ref: values[4], sort_order: values[5], uploaded_by_actor_id: values[6] }
      this.videos.push(video)
      return result([video])
    }
    if (text.startsWith('UPDATE workspace_customer_delivery_videos')) {
      const video = this.videos.find(video => video.workspace_id === values[0] && video.delivery_id === values[1]
        && video.id === values[2] && !video.deleted_at)
      if (!video) return result()
      video.deleted_at = this.row.updated_at
      return result([video])
    }
    if (text.startsWith('UPDATE workspace_customer_deliveries')) {
      if (text.includes('SET effective_at=CASE')) {
        this.row.effective_at = values[2] ? this.row.effective_at ?? this.row.updated_at : null
      } else {
        const set = text.slice(text.indexOf(' SET ') + 5, text.indexOf(' WHERE '))
        for (const [, column, parameter] of set.matchAll(/([a-z_]+)=\$(\d+)/gu))
          this.row[column!] = structuredClone(values[Number(parameter) - 1])
        for (const [, column, value] of set.matchAll(/([a-z_]+)='(complete|incomplete)'/gu))
          this.row[column!] = value
        if (set.includes('revision=revision+1')) this.row.revision++
      }
      return result([this.row])
    }
    if (text.startsWith('INSERT INTO workspace_operation_audit')) {
      this.audits = [...this.audits, [...values]]
      if (this.auditFailure) throw this.auditFailure
      return result()
    }
    throw new Error(`Unexpected repository SQL: ${text}`)
  }
}

const mutationKinds = ['update', 'item', 'batch', 'addVideo', 'removeVideo'] as const
type MutationKind = typeof mutationKinds[number]

function mutatePostgres(repo: PostgresCustomerDeliveryRepository, kind: MutationKind, expectedRevision = 4) {
  const scope = { workspaceId: 'ws_pg', deliveryId: 'cd_pg', actorId: 'operator-1' }
  if (kind === 'update') return repo.update({ ...scope, id: scope.deliveryId, expectedRevision,
    patch: { paymentEvidenceRefs: ['asset_new_payment'] } })
  if (kind === 'item') return repo.updateChecklistItem({ ...scope, expectedRevision, checklistKey: 'system_integration',
    itemKey: '店铺连接', completed: true, evidence: { asset_refs: ['asset_new_item'] } })
  if (kind === 'batch') return repo.updateChecklistItems({ ...scope, expectedRevision, checklistKey: 'functional_acceptance',
    items: CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS.functional_acceptance.map((itemKey, index) => ({ itemKey, completed: true,
      evidence: { asset_refs: [`asset_new_batch_${index}`] } })) })
  if (kind === 'addVideo') return repo.addVideo({ ...scope, title: 'Reference only', assetRef: 'asset_new_video' })
  return repo.removeVideo({ ...scope, videoId: 'video_1' })
}

function evidenceTuples(client: RecordingClient) {
  return client.calls.filter(call => call.text.includes('assert_customer_delivery_evidence_asset')).map(call => call.values!.slice(2))
}

function expectAssetsBeforeParent(client: RecordingClient) {
  const lock = client.calls.findIndex(call => call.text.includes('FOR UPDATE'))
  expect(lock).toBeGreaterThan(-1)
  expect(client.calls[lock]!.text).toContain('delivery_evidence_recheck')
  expect(client.calls.filter(call => call.text.includes('delivery_evidence_preflight_'))).toHaveLength(3)
  for (const [index, call] of client.calls.entries()) {
    if (call.text.includes('delivery_evidence_preflight_')) expect(call.text).not.toMatch(/FOR (UPDATE|SHARE)/u)
    if (call.text.includes('assert_customer_delivery_evidence_asset')) {
      expect(index).toBeLessThan(lock)
      expect(call.values?.slice(0, 2)).toEqual(['ws_pg', 'cd_pg'])
    }
  }
  const tuples = evidenceTuples(client)
  expect(tuples).toEqual([...tuples].sort((a, b) => String(a[1]) < String(b[1]) ? -1 : String(a[1]) > String(b[1]) ? 1
    : String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0))
  expect(new Set(tuples.map(tuple => JSON.stringify(tuple))).size).toBe(tuples.length)
}

describe('PostgreSQL delivery evidence preflight transaction protocol', () => {
  it.each(mutationKinds)('locks the complete candidate evidence before its parent for %s, without late asset SQL', async kind => {
    const client = new EvidenceTransactionClient()
    client.row.contract_ref = 'asset_ref_contract_z'
    client.videos.push(postgresVideo('video_2', 'asset_video_retained'))
    client.videos.push({ ...postgresVideo('video_deleted', 'asset_deleted'), deleted_at: client.row.updated_at })
    const repo = new PostgresCustomerDeliveryRepository(new RecordingPool(client))
    await mutatePostgres(repo, kind)
    expectAssetsBeforeParent(client)
    const expected = [
      ['contract', client.row.contract_ref],
      ...client.row.payment_evidence_refs.map((ref: string) => ['payment', ref]),
      ...client.row.training_evidence_refs.map((ref: string) => ['training', ref]),
      ...client.items.flatMap(item => item.evidence.asset_refs.map((ref: string) => [item.checklist_key, ref])),
      ...client.videos.filter(video => !video.deleted_at).map(video => ['video', video.asset_ref]),
    ]
    expect(evidenceTuples(client)).toEqual(expect.arrayContaining(expected))
    expect(evidenceTuples(client)).toHaveLength(expected.length)
    expect(evidenceTuples(client).some(tuple => tuple[1] === 'asset_deleted')).toBe(false)
    expect(client.row).toMatchObject({ revision: 5, effective_at: expect.any(String) })
    expect(client.audits).toHaveLength(1)
    expect(client.calls.at(-1)?.text).toBe('COMMIT')
  })

  it('deduplicates repeated references per purpose but verifies the same asset separately for every purpose', async () => {
    const client = new EvidenceTransactionClient()
    client.row.payment_evidence_refs = ['asset_shared', 'asset_shared']
    client.row.training_evidence_refs = ['asset_shared']
    client.items[0]!.evidence.asset_refs = ['asset_shared', 'asset_shared']
    client.items[1]!.evidence.asset_refs = ['asset_shared']
    await new PostgresCustomerDeliveryRepository(new RecordingPool(client)).update({ workspaceId: 'ws_pg', id: 'cd_pg',
      actorId: 'operator-1', expectedRevision: 4, patch: { companyName: 'Renamed' } })
    expectAssetsBeforeParent(client)
    expect(evidenceTuples(client).filter(tuple => tuple[1] === 'asset_shared')).toEqual([
      ['payment', 'asset_shared'], ['system_integration', 'asset_shared'], ['training', 'asset_shared'],
    ])
  })

  it.each(['metadata', 'payment', 'training'] as const)('keeps incomplete historical evidence repairable during %s changes', async repair => {
    const client = new EvidenceTransactionClient()
    client.items = []
    client.row.payment_evidence_refs = ['asset_old_blocked']
    client.row.training_evidence_refs = ['asset_old_blocked']
    client.blockedAssets.add('asset_old_blocked')
    const patch = repair === 'metadata' ? { companyName: 'Repair metadata' }
      : repair === 'payment' ? { paymentEvidenceRefs: ['asset_repair'] } : { trainingEvidenceRefs: ['asset_repair'] }
    await new PostgresCustomerDeliveryRepository(new RecordingPool(client)).update({ workspaceId: 'ws_pg', id: 'cd_pg',
      actorId: 'operator-1', expectedRevision: 4, patch })
    expect(evidenceTuples(client)).toEqual(repair === 'metadata' ? [] : [[repair, 'asset_repair']])
    expect(client.row.effective_at).toBeNull()
    expect(client.audits).toHaveLength(1)
    expect(client.calls.at(-1)?.text).toBe('COMMIT')
  })

  it.each(['update', 'item', 'batch'] as const)('rolls back a changed preflight revision without retrying caller-versioned %s', async kind => {
    const client = new EvidenceTransactionClient()
    client.revisionChanges = 1
    await expect(mutatePostgres(new PostgresCustomerDeliveryRepository(new RecordingPool(client)), kind))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(client.calls.filter(call => call.text === 'BEGIN')).toHaveLength(1)
    expect(client.calls.some(call => /^(INSERT|UPDATE) /u.test(call.text))).toBe(false)
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
    expect(client.row.revision).toBe(5)
    expect(client.audits).toEqual([])
  })

  it('rejects an already-stale caller revision before asserting any evidence or locking the parent', async () => {
    const client = new EvidenceTransactionClient()
    await expect(mutatePostgres(new PostgresCustomerDeliveryRepository(new RecordingPool(client)), 'update', 3))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(evidenceTuples(client)).toEqual([])
    expect(client.calls.some(call => call.text.includes('FOR UPDATE'))).toBe(false)
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
  })

  it.each(['addVideo', 'removeVideo'] as const)('restarts the whole %s transaction on two revision races and commits only once', async kind => {
    const client = new EvidenceTransactionClient()
    client.revisionChanges = 2
    await mutatePostgres(new PostgresCustomerDeliveryRepository(new RecordingPool(client)), kind)
    expect(client.calls.filter(call => call.text === 'BEGIN')).toHaveLength(3)
    expect(client.calls.filter(call => call.text === 'ROLLBACK')).toHaveLength(2)
    expect(client.calls.filter(call => call.text === 'COMMIT')).toHaveLength(1)
    const preflights = client.calls.filter(call => call.text.includes('delivery_evidence_preflight_parent'))
    expect(preflights).toHaveLength(3)
    const lastRollback = client.calls.map(call => call.text).lastIndexOf('ROLLBACK')
    expect(client.calls.slice(0, lastRollback).some(call => /^(INSERT|UPDATE) /u.test(call.text))).toBe(false)
    expect(client.row.revision).toBe(7)
    expect(client.audits).toHaveLength(1)
    expect(client.videos.filter(video => !video.deleted_at)).toHaveLength(kind === 'addVideo' ? 2 : 0)
  })

  it.each(['addVideo', 'removeVideo'] as const)('bounds %s revision-race retries at three whole transactions', async kind => {
    const client = new EvidenceTransactionClient()
    client.revisionChanges = 10
    await expect(mutatePostgres(new PostgresCustomerDeliveryRepository(new RecordingPool(client)), kind))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(client.calls.filter(call => call.text === 'BEGIN')).toHaveLength(3)
    expect(client.calls.filter(call => call.text === 'ROLLBACK')).toHaveLength(3)
    expect(client.calls.some(call => /^(INSERT|UPDATE) /u.test(call.text) || call.text === 'COMMIT')).toBe(false)
    expect(client.audits).toEqual([])
  })

  it.each(mutationKinds)('rolls back all %s writes and audit on audit failure without retry', async kind => {
    const client = new EvidenceTransactionClient()
    const before = structuredClone({ row: client.row, videos: client.videos, items: client.items })
    const failure = new Error('audit unavailable')
    client.auditFailure = failure
    await expect(mutatePostgres(new PostgresCustomerDeliveryRepository(new RecordingPool(client)), kind)).rejects.toBe(failure)
    expect(client.calls.some(call => call.text.includes('SET effective_at=CASE'))).toBe(true)
    expect(client.calls.some(call => call.text.includes('INSERT INTO workspace_operation_audit'))).toBe(true)
    expect(client.calls.filter(call => call.text === 'BEGIN')).toHaveLength(1)
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
    expect({ row: client.row, videos: client.videos, items: client.items }).toEqual(before)
    expect(client.audits).toEqual([])
  })

  it.each(['23514', '42501', '40P01', '55P03', '08006'])('propagates asset assertion SQLSTATE %s without silently retrying video writes', async code => {
    const client = new EvidenceTransactionClient()
    const failure = Object.assign(new Error('asset assertion failed'), { code })
    client.assertionFailure = failure
    await expect(mutatePostgres(new PostgresCustomerDeliveryRepository(new RecordingPool(client)), 'addVideo')).rejects.toBe(failure)
    expect(client.calls.filter(call => call.text === 'BEGIN')).toHaveLength(1)
    expect(client.calls.some(call => call.text.includes('FOR UPDATE') || /^(INSERT|UPDATE) /u.test(call.text))).toBe(false)
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
  })

  it.each(['update', 'addVideo'] as const)('fails closed on a previously unverified purpose/ref after parent locking in %s', async kind => {
    const client = new EvidenceTransactionClient()
    const before = structuredClone({ row: client.row, videos: client.videos, items: client.items })
    // Inject an impossible-under-correct-parent-locking body snapshot to test
    // the defensive guard itself, not claim a live concurrent DB reproduction.
    client.lockedBodyChange = current => { current.items[0]!.evidence.asset_refs = ['asset_unlocked_late'] }
    await expect(mutatePostgres(new PostgresCustomerDeliveryRepository(new RecordingPool(client)), kind))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expectAssetsBeforeParent(client)
    expect(evidenceTuples(client).some(tuple => tuple[1] === 'asset_unlocked_late')).toBe(false)
    expect(client.calls.filter(call => call.text === 'BEGIN')).toHaveLength(1)
    expect(client.calls.some(call => call.text.includes('INSERT INTO workspace_operation_audit'))).toBe(false)
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
    expect({ row: client.row, videos: client.videos, items: client.items }).toEqual(before)
  })

  it.each(['parent', 'item', 'video'] as const)('rejects same-revision %s evidence changes between preflight and parent recheck', async changed => {
    const client = new EvidenceTransactionClient()
    client.recheckChange = current => {
      if (changed === 'parent') current.row.payment_evidence_refs = ['asset_changed_between_reads']
      else if (changed === 'item') current.items[0]!.evidence.asset_refs = ['asset_changed_between_reads']
      else current.videos[0]!.asset_ref = 'asset_changed_between_reads'
    }
    await expect(mutatePostgres(new PostgresCustomerDeliveryRepository(new RecordingPool(client)), 'update'))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expectAssetsBeforeParent(client)
    expect(client.row.revision).toBe(4)
    expect(evidenceTuples(client).some(tuple => tuple[1] === 'asset_changed_between_reads')).toBe(false)
    expect(client.calls.some(call => /^(INSERT|UPDATE) /u.test(call.text))).toBe(false)
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
  })

  it.each(mutationKinds)('maps a busy NOWAIT parent to a conflict for %s without retrying or writing', async kind => {
    const client = new EvidenceTransactionClient()
    client.videos.push(postgresVideo('video_2', 'asset_retained_video'))
    const before = structuredClone({ row: client.row, videos: client.videos, items: client.items })
    client.queryFailures.set('delivery_evidence_recheck */', Object.assign(new Error('parent is locked'), { code: '55P03' }))
    await expect(mutatePostgres(new PostgresCustomerDeliveryRepository(new RecordingPool(client)), kind))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(evidenceTuples(client).length).toBeGreaterThan(0)
    expectAssetsBeforeParent(client)
    expect(client.calls.find(call => call.text.includes('delivery_evidence_recheck */'))?.text).toContain('FOR UPDATE NOWAIT')
    expect(client.calls.filter(call => call.text === 'BEGIN')).toHaveLength(1)
    expect(client.calls.some(call => /^(INSERT|UPDATE) /u.test(call.text) || call.text === 'COMMIT')).toBe(false)
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
    expect(client.audits).toEqual([])
    expect({ row: client.row, videos: client.videos, items: client.items }).toEqual(before)
  })

  it.each(['delivery_evidence_preflight_items', 'delivery_evidence_recheck_videos'])('does not map unrelated query 55P03 at %s to a revision conflict', async marker => {
    const client = new EvidenceTransactionClient()
    const failure = Object.assign(new Error('non-parent query lock unavailable'), { code: '55P03' })
    client.queryFailures.set(marker, failure)
    await expect(mutatePostgres(new PostgresCustomerDeliveryRepository(new RecordingPool(client)), 'addVideo')).rejects.toBe(failure)
    expect(client.calls.filter(call => call.text === 'BEGIN')).toHaveLength(1)
    expect(client.calls.some(call => /^(INSERT|UPDATE) /u.test(call.text))).toBe(false)
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
  })
})

describe('PostgreSQL delivery evidence read protocol', () => {
  function activeClient() {
    const client = new EvidenceTransactionClient()
    client.row.effective_at = '2026-09-13T00:00:00.000Z'
    client.row.contract_ref = 'asset_ref_contract_z'
    return client
  }

  function expectNoAssetSqlUnderParentLock(client: RecordingClient) {
    let parentLocked = false
    for (const call of client.calls) {
      if (call.text === 'BEGIN' || call.text === 'ROLLBACK' || call.text === 'COMMIT') parentLocked = false
      if (call.text.includes('FOR SHARE')) parentLocked = true
      if (call.text.includes('assert_customer_delivery_evidence_asset')) expect(parentLocked).toBe(false)
    }
  }

  it.each(['get', 'list', 'empty-patch'] as const)('downgrades unavailable evidence only in the %s projection without persisting it', async operation => {
    const client = activeClient()
    const before = structuredClone(client.row)
    client.assertionFailure = Object.assign(new Error('customer delivery evidence is unavailable'), { code: '23514' })
    const repo = new PostgresCustomerDeliveryRepository(new RecordingPool(client))
    const result = operation === 'get' ? await repo.get('ws_pg', 'cd_pg')
      : operation === 'list' ? (await repo.list('ws_pg'))[0]
        : await repo.update({ workspaceId: 'ws_pg', id: 'cd_pg', actorId: 'operator-1', expectedRevision: 4, patch: {} })
    expect(result).toMatchObject({ effectiveAt: null, revision: 4 })
    expect(client.calls.some(call => call.text === 'ROLLBACK TO SAVEPOINT customer_delivery_read_evidence')).toBe(true)
    expect(client.calls.some(call => call.text === 'RELEASE SAVEPOINT customer_delivery_read_evidence')).toBe(true)
    expect(client.calls.some(call => /^(INSERT|UPDATE) /u.test(call.text))).toBe(false)
    expectNoAssetSqlUnderParentLock(client)
    expect(client.row).toEqual(before)
    expect(client.audits).toEqual([])
    expect(client.calls.at(-1)?.text).toBe('COMMIT')
  })

  it.each([
    ['42501', 'customer delivery evidence is unavailable'],
    ['08006', 'connection failed'],
    ['42883', 'assertion function does not exist'],
    ['40P01', 'deadlock detected'],
    ['55P03', 'lock unavailable'],
    ['23514', 'unrelated constraint failure'],
    [undefined, 'customer delivery evidence is unavailable'],
    ['23514', undefined],
  ])('does not hide non-domain read errors (%s, %s) as incomplete delivery', async (code, message) => {
    const client = activeClient()
    const failure = Object.assign(new Error(message), code ? { code } : {})
    client.assertionFailure = failure
    await expect(new PostgresCustomerDeliveryRepository(new RecordingPool(client)).get('ws_pg', 'cd_pg')).rejects.toBe(failure)
    expect(client.calls.filter(call => call.text === 'BEGIN')).toHaveLength(1)
    expect(client.calls.some(call => call.text.includes('FOR SHARE') || /^(INSERT|UPDATE) /u.test(call.text))).toBe(false)
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
  })

  it('validates all six purposes in sorted asset order before sharing the parent lock', async () => {
    const client = activeClient()
    const result = await new PostgresCustomerDeliveryRepository(new RecordingPool(client)).get('ws_pg', 'cd_pg')
    expect(result?.effectiveAt).toBe(client.row.effective_at)
    const tuples = evidenceTuples(client)
    expect(tuples).toHaveLength(22)
    expect(new Set(tuples.map(tuple => tuple[0]))).toEqual(new Set([
      'contract', 'payment', 'training', 'system_integration', 'functional_acceptance', 'video',
    ]))
    expect(tuples.map(tuple => tuple[1])).toEqual(tuples.map(tuple => tuple[1]).sort())
    expectNoAssetSqlUnderParentLock(client)
    expect(client.calls.findIndex(call => call.text.includes('FOR SHARE')))
      .toBeGreaterThan(client.calls.findIndex(call => call.text === 'RELEASE SAVEPOINT customer_delivery_read_evidence'))
    expect(client.calls.some(call => /^(INSERT|UPDATE) /u.test(call.text))).toBe(false)
  })

  it.each(['ineffective', 'structurally-incomplete'] as const)('does not assert historical assets for %s reads', async state => {
    const client = activeClient()
    if (state === 'ineffective') client.row.effective_at = null
    else client.items.pop()
    client.assertionFailure = new Error('must not query asset trust')
    const result = await new PostgresCustomerDeliveryRepository(new RecordingPool(client)).get('ws_pg', 'cd_pg')
    expect(result?.effectiveAt).toBeNull()
    expect(evidenceTuples(client)).toEqual([])
    expect(client.calls.some(call => call.text.startsWith('SAVEPOINT'))).toBe(false)
    expect(client.calls.at(-1)?.text).toBe('COMMIT')
  })

  it('restarts a read from its new revision and bounds repeated races to three attempts', async () => {
    const client = activeClient()
    client.revisionChanges = 2
    const repo = new PostgresCustomerDeliveryRepository(new RecordingPool(client))
    expect((await repo.get('ws_pg', 'cd_pg'))?.revision).toBe(6)
    expect(client.calls.filter(call => call.text === 'BEGIN')).toHaveLength(3)
    expect(client.calls.filter(call => call.text === 'ROLLBACK')).toHaveLength(2)
    expectNoAssetSqlUnderParentLock(client)
    client.calls.length = 0
    client.revisionChanges = 10
    await expect(repo.get('ws_pg', 'cd_pg')).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(client.calls.filter(call => call.text === 'BEGIN')).toHaveLength(3)
    expect(client.calls.filter(call => call.text === 'ROLLBACK')).toHaveLength(3)
    expect(client.calls.some(call => call.text === 'COMMIT')).toBe(false)
  })

  it.each(['parent', 'item', 'video'] as const)('restarts when %s evidence changes without a revision increment', async changed => {
    const client = activeClient()
    client.recheckChange = current => {
      if (changed === 'parent') current.row.payment_evidence_refs = []
      else if (changed === 'item') current.items[0]!.evidence.asset_refs = []
      else current.videos = []
    }
    const result = await new PostgresCustomerDeliveryRepository(new RecordingPool(client)).get('ws_pg', 'cd_pg')
    expect(result).toMatchObject({ effectiveAt: changed === 'video' ? null : client.row.effective_at, revision: 4 })
    expect(client.row.effective_at).not.toBeNull()
    expect(client.calls.filter(call => call.text === 'BEGIN')).toHaveLength(2)
    expect(client.calls.filter(call => call.text === 'ROLLBACK')).toHaveLength(1)
    expectNoAssetSqlUnderParentLock(client)
    expect(client.calls.some(call => /^(INSERT|UPDATE) /u.test(call.text))).toBe(false)
  })

  it('releases the first list delivery parent before the next delivery asset validation transaction', async () => {
    const listing = new RecordingClient()
    listing.enqueue(); listing.enqueue(); listing.enqueue({ id: 'cd_pg' }, { id: 'cd_second' }); listing.enqueue()
    const first = activeClient()
    const second = activeClient()
    second.row.id = 'cd_second'
    for (const row of [...second.items, ...second.videos]) row.delivery_id = 'cd_second'
    const clients = [listing, first, second]
    let connection = 0
    const pool: SqlPool = { async connect() {
      if (connection > 0) expect(clients[connection - 1]!.calls.at(-1)?.text).toBe('COMMIT')
      const client = clients[connection++]
      if (!client) throw new Error('unexpected additional read transaction')
      return client
    } }
    const result = await new PostgresCustomerDeliveryRepository(pool).list('ws_pg')
    expect(result.map(delivery => delivery.id)).toEqual(['cd_pg', 'cd_second'])
    expect(connection).toBe(3)
    for (const client of [first, second]) {
      expect(evidenceTuples(client)).toHaveLength(22)
      expectNoAssetSqlUnderParentLock(client)
      expect(client.calls.at(-1)?.text).toBe('COMMIT')
      for (const call of client.calls.filter(call => call.text.includes('assert_customer_delivery_evidence_asset')))
        expect(call.values?.slice(0, 2)).toEqual(['ws_pg', client.row.id])
    }
  })

  it('keeps an empty PostgreSQL patch revision-checked without writing or auditing', async () => {
    const client = activeClient()
    const repo = new PostgresCustomerDeliveryRepository(new RecordingPool(client))
    await expect(repo.update({ workspaceId: 'ws_pg', id: 'cd_pg', actorId: 'operator-1', expectedRevision: 3, patch: {} }))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(client.calls.some(call => /^(INSERT|UPDATE) /u.test(call.text) || call.text.includes('FOR UPDATE'))).toBe(false)
    expect(client.audits).toEqual([])
  })

  it.each(['get', 'list'] as const)('maps a busy NOWAIT read parent to a conflict for %s without retrying', async operation => {
    const client = activeClient()
    client.queryFailures.set('delivery_evidence_read_recheck */', Object.assign(new Error('read parent is locked'), { code: '55P03' }))
    const repo = new PostgresCustomerDeliveryRepository(new RecordingPool(client))
    await expect(operation === 'get' ? repo.get('ws_pg', 'cd_pg') : repo.list('ws_pg'))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(evidenceTuples(client)).toHaveLength(22)
    expectNoAssetSqlUnderParentLock(client)
    expect(client.calls.find(call => call.text.includes('delivery_evidence_read_recheck */'))?.text).toContain('FOR SHARE NOWAIT')
    expect(client.calls.filter(call => call.text === 'BEGIN')).toHaveLength(operation === 'get' ? 1 : 2)
    expect(client.calls.filter(call => call.text.includes('delivery_evidence_read_parent'))).toHaveLength(1)
    expect(client.calls.some(call => /^(INSERT|UPDATE) /u.test(call.text))).toBe(false)
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
    expect(client.audits).toEqual([])
  })

  it.each(['delivery_evidence_read_items', 'delivery_evidence_read_recheck_videos'])('propagates non-parent read 55P03 from %s unchanged', async marker => {
    const client = activeClient()
    const failure = Object.assign(new Error('non-parent read query lock unavailable'), { code: '55P03' })
    client.queryFailures.set(marker, failure)
    await expect(new PostgresCustomerDeliveryRepository(new RecordingPool(client)).get('ws_pg', 'cd_pg')).rejects.toBe(failure)
    expect(client.calls.filter(call => call.text === 'BEGIN')).toHaveLength(1)
    expect(client.calls.some(call => /^(INSERT|UPDATE) /u.test(call.text))).toBe(false)
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
  })
})

describe('Canonical evidence writes and profile withdrawal', () => {
  it('allows withdrawing a complete profile without asserting or rewriting its old blocked contract', async () => {
    const client = new EvidenceTransactionClient()
    client.row.contract_ref = 'asset_ref_contract_blocked'
    client.row.effective_at = '2026-09-13T00:00:00.000Z'
    client.blockedAssets.add('asset_ref_contract_blocked')
    const result = await new PostgresCustomerDeliveryRepository(new RecordingPool(client)).update({
      workspaceId: 'ws_pg', id: 'cd_pg', actorId: 'operator-1', expectedRevision: 4,
      patch: { customerProfileStatus: 'incomplete' },
    })
    expect(result).toMatchObject({ customerProfileStatus: 'incomplete', contractRef: 'asset_ref_contract_blocked', effectiveAt: null, revision: 5 })
    expect(evidenceTuples(client)).toEqual([])
    expect(client.row.contract_ref).toBe('asset_ref_contract_blocked')
    expect(JSON.parse(String(client.audits[0]?.[7]))).toMatchObject({
      customerProfileStatus: 'incomplete', contractRef: 'asset_ref_contract_blocked', effectiveAt: null,
    })
    expect(client.calls.at(-1)?.text).toBe('COMMIT')
  })

  it.each(['profile-completion', 'explicit-contract'] as const)('still rejects a blocked contract for %s', async operation => {
    const client = new EvidenceTransactionClient()
    client.row.customer_profile_status = 'incomplete'
    client.row.contract_ref = 'asset_ref_contract_blocked'
    client.blockedAssets.add('asset_ref_contract_blocked')
    const before = structuredClone(client.row)
    const patch: CustomerDeliveryPatch = operation === 'profile-completion'
      ? { customerProfileStatus: 'complete' }
      : { customerProfileStatus: 'incomplete', contractRef: ' \tasset_ref_contract_blocked\u00a0' }
    const originalPatch = structuredClone(patch)
    await expect(new PostgresCustomerDeliveryRepository(new RecordingPool(client)).update({
      workspaceId: 'ws_pg', id: 'cd_pg', actorId: 'operator-1', expectedRevision: 4, patch,
    })).rejects.toThrow('blocked or unbound evidence asset')
    expect(evidenceTuples(client).filter(tuple => tuple[0] === 'contract')).toEqual([['contract', 'asset_ref_contract_blocked']])
    expect(client.calls.some(call => call.text.includes('FOR UPDATE') || /^(INSERT|UPDATE) /u.test(call.text))).toBe(false)
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
    expect(client.row).toEqual(before)
    expect(patch).toEqual(originalPatch)
    expect(client.audits).toEqual([])
  })

  it.each(['memory', 'postgres'] as const)('uses the canonical new contract reference in %s persistence and audit without mutating input', async storage => {
    const patch = Object.freeze({ contractRef: ' \tasset_ref_contract_canonical\u00a0' })
    const originalPatch = structuredClone(patch)
    if (storage === 'memory') {
      const events: any[] = []
      const repo = new MemoryCustomerDeliveryRepository(event => { events.push(event) })
      const draft = await repo.create({ workspaceId: 'ws_canonical', companyName: 'Canonical', actorId: 'operator-1' })
      const saved = await repo.update({ workspaceId: draft.workspaceId, id: draft.id, actorId: 'operator-1', expectedRevision: draft.revision, patch })
      expect(saved.contractRef).toBe('asset_ref_contract_canonical')
      expect((await repo.get(draft.workspaceId, draft.id))?.contractRef).toBe('asset_ref_contract_canonical')
      expect(events.at(-1)).toMatchObject({ after: { contractRef: 'asset_ref_contract_canonical' },
        evidence: { patch: { contractRef: 'asset_ref_contract_canonical' } } })
    } else {
      const client = new EvidenceTransactionClient()
      client.items = []
      const result = await new PostgresCustomerDeliveryRepository(new RecordingPool(client)).update({
        workspaceId: 'ws_pg', id: 'cd_pg', actorId: 'operator-1', expectedRevision: 4, patch,
      })
      expect(result.contractRef).toBe('asset_ref_contract_canonical')
      expect(client.row.contract_ref).toBe('asset_ref_contract_canonical')
      expect(evidenceTuples(client)).toEqual([['contract', 'asset_ref_contract_canonical']])
      const write = client.calls.find(call => call.text.startsWith('UPDATE workspace_customer_deliveries SET contract_ref='))!
      expect(write.values?.[4]).toBe('asset_ref_contract_canonical')
      expect(JSON.parse(String(client.audits[0]?.[7]))).toMatchObject({ contractRef: 'asset_ref_contract_canonical' })
      expectAssetsBeforeParent(client)
    }
    expect(patch).toEqual(originalPatch)
  })

  it.each(['memory-single', 'memory-batch', 'postgres-single', 'postgres-batch'] as const)(
    'normalizes only asset reference strings consistently across %s stage, persistence and audit', async operation => {
      const batch = operation.endsWith('batch')
      const inputs = (batch ? CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS.system_integration : ['店铺连接']).map((itemKey, index) => ({
        itemKey, completed: true, evidence: {
          asset_refs: [` \tasset_canonical_item_${index}\u00a0`, `\nasset_canonical_extra_${index} `],
          note: ` \t note ${index} remains verbatim \n`, nested: { label: '  leave other evidence unchanged  ' },
        },
      }))
      const originalInput = structuredClone(inputs)
      for (const item of inputs) {
        Object.freeze(item.evidence.asset_refs)
        Object.freeze(item.evidence.nested)
        Object.freeze(item.evidence)
        Object.freeze(item)
      }
      Object.freeze(inputs)
      const expected = originalInput.map((item, index) => ({ ...item,
        evidence: { ...item.evidence, asset_refs: [`asset_canonical_item_${index}`, `asset_canonical_extra_${index}`] } }))
      if (operation.startsWith('memory')) {
        const events: any[] = []
        const repo = new MemoryCustomerDeliveryRepository(event => { events.push(event) })
        const draft = await repo.create({ workspaceId: 'ws_canonical_items', companyName: 'Canonical items', actorId: 'operator-1' })
        const paid = await repo.update({ workspaceId: draft.workspaceId, id: draft.id, actorId: 'operator-1', expectedRevision: draft.revision,
          patch: { paymentStatus: 'paid', paymentDate: '2026-09-14', paymentEvidenceRefs: ['asset_payment'] } })
        const scope = { workspaceId: paid.workspaceId, deliveryId: paid.id, actorId: 'operator-1', expectedRevision: paid.revision,
          checklistKey: 'system_integration' as const }
        const saved = batch ? await repo.updateChecklistItems({ ...scope, items: inputs })
          : [await repo.updateChecklistItem({ ...scope, ...inputs[0]! })]
        expect(saved.map(item => ({ itemKey: item.itemKey, completed: item.completed, evidence: item.evidence }))).toEqual(expected)
        const persisted = await repo.listChecklistItems(scope)
        for (const item of expected) expect(persisted.find(row => row.itemKey === item.itemKey)?.evidence).toEqual(item.evidence)
        const after = events.at(-1)!.after
        const audited = batch ? after.items : [after]
        expect(audited.map((item: any) => ({ itemKey: item.itemKey, completed: item.completed, evidence: item.evidence }))).toEqual(expected)
      } else {
        const client = new EvidenceTransactionClient()
        // Keep the candidate structurally incomplete so only newly attached
        // evidence is checked; unrelated historical evidence is not rewritten.
        client.row.training_completed = false
        const oldAcceptance = structuredClone(client.items.filter(item => item.checklist_key === 'functional_acceptance'))
        const repo = new PostgresCustomerDeliveryRepository(new RecordingPool(client))
        const scope = { workspaceId: 'ws_pg', deliveryId: 'cd_pg', actorId: 'operator-1', expectedRevision: 4,
          checklistKey: 'system_integration' as const }
        const saved = batch ? await repo.updateChecklistItems({ ...scope, items: inputs })
          : [await repo.updateChecklistItem({ ...scope, ...inputs[0]! })]
        expect(saved.map(item => ({ itemKey: item.itemKey, completed: item.completed, evidence: item.evidence }))).toEqual(expected)
        for (const item of expected)
          expect(client.items.find(row => row.checklist_key === 'system_integration' && row.item_key === item.itemKey)?.evidence).toEqual(item.evidence)
        const writes = client.calls.filter(call => call.text.startsWith('INSERT INTO workspace_customer_delivery_checklist_items'))
        expect(writes.map(call => JSON.parse(String(call.values?.[5])))).toEqual(expected.map(item => item.evidence))
        const after = JSON.parse(String(client.audits[0]?.[7]))
        const audited = batch ? after.items : [after]
        expect(audited.map((item: any) => ({ itemKey: item.itemKey, completed: item.completed, evidence: item.evidence }))).toEqual(expected)
        expect(evidenceTuples(client)).toEqual(expect.arrayContaining(expected.flatMap(item =>
          item.evidence.asset_refs.map(ref => ['system_integration', ref]))))
        expect(evidenceTuples(client)).toHaveLength(expected.length * 2)
        expectAssetsBeforeParent(client)
        expect(client.items.filter(item => item.checklist_key === 'functional_acceptance')).toEqual(oldAcceptance)
      }
      expect(inputs).toEqual(originalInput)
    },
  )
})

describe('MemoryCustomerDeliveryRepository audit and lifecycle', () => {
  it('archives records recoverably and permits a replacement with the same company name', async () => {
    const repo = new MemoryCustomerDeliveryRepository()
    const original = await repo.create({ workspaceId: 'ws_archive', companyName: 'Acme', actorId: 'creator' })
    const archived = await repo.update({ workspaceId: original.workspaceId, id: original.id, actorId: 'operator', expectedRevision: original.revision, patch: { archivedAt: '2026-09-15T12:00:00.000Z' } })
    expect(archived).toMatchObject({ archivedAt: '2026-09-15T12:00:00.000Z', archivedByActorId: 'operator', updatedByActorId: 'operator' })
    expect(await repo.list(original.workspaceId)).toEqual([])
    await expect(repo.create({ workspaceId: original.workspaceId, companyName: 'Acme', actorId: 'creator-2' })).resolves.toMatchObject({ companyName: 'Acme', archivedAt: null })
  })

  it('preserves PostgreSQL DATE calendar values separately from timestamp instants', async () => {
    for (const paymentDate of [new Date(2026, 8, 14), '2026-09-14']) {
      const client = new EvidenceTransactionClient()
      client.row = postgresRow({ id: 'cd_date', workspace_id: 'ws_date', payment_date: paymentDate,
        planned_go_live_at: new Date('2026-10-01T09:00:00+08:00'),
        created_at: new Date(), updated_at: new Date(), revision: 1 })
      const result = await new PostgresCustomerDeliveryRepository(new RecordingPool(client)).get('ws_date', 'cd_date')
      expect(result?.paymentDate).toBe('2026-09-14')
      expect(result?.plannedGoLiveAt).toBe('2026-10-01T01:00:00.000Z')
    }
  })

  it('accepts only asset references as contract completion evidence', async () => {
    expect(isValidCustomerDeliveryContractRef('https://example.com/contracts/acme.pdf')).toBe(false)
    expect(isValidCustomerDeliveryContractRef('http://example.com/contracts/acme.pdf')).toBe(false)
    expect(isValidCustomerDeliveryContractRef('https://')).toBe(false)
    expect(isValidCustomerDeliveryContractRef('asset_ref_contract-1')).toBe(true)
    expect(isValidCustomerDeliveryContractRef('local-file.pdf')).toBe(false)
    const repo = new MemoryCustomerDeliveryRepository()
    const d = await repo.create({ workspaceId: 'ws_contract', companyName: 'Acme', actorId: 'operator-1' })
    await expect(repo.update({ workspaceId: d.workspaceId, id: d.id, actorId: 'operator-1', expectedRevision: d.revision, patch: { contractRef: 'http://insecure.example/contract.pdf' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(repo.update({ workspaceId: d.workspaceId, id: d.id, actorId: 'operator-1', expectedRevision: d.revision, patch: { contractRef: 'https://example.com/contracts/acme.pdf' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('fails closed when an already-complete profile receives an invalid contract reference', async () => {
    const repo = new MemoryCustomerDeliveryRepository()
    const d = await repo.create({ workspaceId: 'ws_contract_complete', companyName: 'Acme', actorId: 'operator-1' })
    const complete = await repo.update({ workspaceId: d.workspaceId, id: d.id, actorId: 'operator-1', expectedRevision: d.revision, patch: { contractNumber: 'C-1', contractRef: 'asset_ref_contract-1', projectOwner: 'owner', supportOwner: 'support', plannedGoLiveAt: '2026-10-01', customerProfileStatus: 'complete' } })
    await expect(repo.update({ workspaceId: d.workspaceId, id: d.id, actorId: 'operator-1', expectedRevision: complete.revision, patch: { contractRef: 'not-a-reference' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('writes audit events without inventing training completion from acceptance', async () => {
    const events: any[] = []
    const repo = new MemoryCustomerDeliveryRepository((event) => { events.push(event) })
    const d = await repo.create({ workspaceId: 'ws_audit', companyName: 'Acme', actorId: 'operator-1' })
    const paid = await repo.update({ workspaceId: d.workspaceId, id: d.id, actorId: 'operator-1', expectedRevision: d.revision, patch: { paymentStatus: 'paid', paymentDate: '2026-09-14', paymentEvidenceRefs: ['asset_payment_1'] } })
    const acceptanceItems = CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS.functional_acceptance.map((itemKey, index) => ({ itemKey, completed: true, evidence: { asset_refs: [`asset_acceptance_${index}`] } }))
    await repo.updateChecklistItems!({ workspaceId: d.workspaceId, deliveryId: d.id, checklistKey: 'functional_acceptance', items: acceptanceItems, actorId: 'operator-1', expectedRevision: paid.revision })
    expect((await repo.get(d.workspaceId, d.id))!.trainingCompleted).toBe(false)
    const video = await repo.addVideo({ workspaceId: d.workspaceId, deliveryId: d.id, actorId: 'operator-1', title: '交付视频', assetRef: 'asset://video-1' })
    expect(events.map((e) => e.action)).toEqual(['customer_delivery.create', 'customer_delivery.update', 'customer_delivery.checklist_items.update', 'customer_delivery.video.add'])
    expect(events[0]).toMatchObject({ actorId: 'operator-1', before: {}, after: { id: d.id, companyName: 'Acme' }, reason: expect.any(String) })
    expect(events[2]).toMatchObject({ evidence: { checklistKey: 'functional_acceptance', itemCount: acceptanceItems.length } })
    await repo.removeVideo!({ workspaceId: d.workspaceId, deliveryId: d.id, videoId: video.id, actorId: 'operator-1' })
    expect((await repo.get(d.workspaceId, d.id))!.videos[0]!.deletedAt).toMatch(/T/)
    expect(events.at(-1)).toMatchObject({ action: 'customer_delivery.video.remove', evidence: { softDelete: true } })
  })

  it('keeps video mutation actor metadata aligned with audit in get and list', async () => {
    const events: any[] = []
    const repo = new MemoryCustomerDeliveryRepository(event => { events.push(event) })
    const draft = await repo.create({ workspaceId: 'ws_video_actor', companyName: 'Video actors', actorId: 'profile-creator' })
    const video = await repo.addVideo({ workspaceId: draft.workspaceId, deliveryId: draft.id, actorId: 'video-uploader', title: '交付视频', assetRef: 'asset_video_actor' })
    const added = { get: await repo.get(draft.workspaceId, draft.id), list: (await repo.list(draft.workspaceId))[0] }
    await repo.removeVideo!({ workspaceId: draft.workspaceId, deliveryId: draft.id, videoId: video.id, actorId: 'video-remover' })
    const removed = { get: await repo.get(draft.workspaceId, draft.id), list: (await repo.list(draft.workspaceId))[0] }

    expect(added).toMatchObject({
      get: { createdByActorId: 'profile-creator', updatedByActorId: 'video-uploader', revision: draft.revision + 1 },
      list: { createdByActorId: 'profile-creator', updatedByActorId: 'video-uploader', revision: draft.revision + 1 },
    })
    expect(removed).toMatchObject({
      get: { createdByActorId: 'profile-creator', updatedByActorId: 'video-remover', revision: draft.revision + 2 },
      list: { createdByActorId: 'profile-creator', updatedByActorId: 'video-remover', revision: draft.revision + 2 },
    })
    expect(video.uploadedByActorId).toBe('video-uploader')
    expect(removed.get!.videos[0]).toMatchObject({ uploadedByActorId: 'video-uploader', deletedAt: expect.any(String) })
    expect(events.map(event => ({ action: event.action, actorId: event.actorId }))).toEqual([
      { action: 'customer_delivery.create', actorId: 'profile-creator' },
      { action: 'customer_delivery.video.add', actorId: added.get!.updatedByActorId },
      { action: 'customer_delivery.video.remove', actorId: removed.get!.updatedByActorId },
    ])
  })

  it('allows manual training confirmation without payment or evidence', async () => {
    const repo = new MemoryCustomerDeliveryRepository()
    const d = await repo.create({ workspaceId: 'ws_unpaid', companyName: 'Acme', actorId: 'operator-1' })
    await expect(repo.update({ workspaceId: d.workspaceId, id: d.id, actorId: 'operator-1', expectedRevision: d.revision, patch: { trainingCompleted: true } })).resolves.toMatchObject({ trainingCompleted: true, trainingEvidenceRefs: [] })
  })

  it('allows manually verified checklist completion for paid rows without uploaded evidence', async () => {
    const repo = new MemoryCustomerDeliveryRepository()
    const d = await repo.create({ workspaceId: 'ws_legacy_payment_gate', companyName: 'Legacy paid', actorId: 'operator-1' })
    const rows = (repo as unknown as { rows: Map<string, CustomerDelivery> }).rows
    Object.assign(rows.get(`${d.workspaceId}:${d.id}`)!, { paymentStatus: 'paid', paymentDate: '2026-09-14', paymentEvidenceRefs: [] })
    const completedItems = CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS.system_integration.map(itemKey => ({
      itemKey, completed: true, evidence: { asset_refs: [`asset_${itemKey}`] },
    }))
    await repo.updateChecklistItem({ workspaceId: d.workspaceId, deliveryId: d.id, checklistKey: 'system_integration',
      itemKey: '店铺连接', completed: true, evidence: { asset_refs: ['asset_store'] }, actorId: 'operator-1', expectedRevision: d.revision,
    })
    const afterSingle = (await repo.get(d.workspaceId, d.id))!
    await expect(repo.updateChecklistItems({ workspaceId: d.workspaceId, deliveryId: d.id, checklistKey: 'system_integration',
      items: completedItems, actorId: 'operator-1', expectedRevision: afterSingle.revision,
    })).resolves.toHaveLength(CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS.system_integration.length)
    expect((await repo.get(d.workspaceId, d.id))?.systemIntegrationStatus).toBe('complete')
  })

  it('allows manual payment, checklist and training confirmation without uploaded evidence', async () => {
    const repo = new MemoryCustomerDeliveryRepository()
    const draft = await repo.create({ workspaceId: 'ws_required_evidence', companyName: 'Evidence Co', actorId: 'operator-1' })
    const paid = await repo.update({ workspaceId: draft.workspaceId, id: draft.id, actorId: 'operator-1', expectedRevision: draft.revision, patch: { paymentStatus: 'paid', paymentDate: '2026-09-14' } })
    await repo.updateChecklistItem!({ workspaceId: paid.workspaceId, deliveryId: paid.id, checklistKey: 'system_integration', itemKey: '店铺连接', completed: true, evidence: { note: '人工核验' }, actorId: 'operator-1', expectedRevision: paid.revision })
    const afterItem = (await repo.get(paid.workspaceId, paid.id))!
    await expect(repo.update({ workspaceId: paid.workspaceId, id: paid.id, actorId: 'operator-1', expectedRevision: afterItem.revision, patch: { trainingCompleted: true } })).resolves.toMatchObject({ trainingCompleted: true, trainingEvidenceRefs: [] })
  })

  it('never marks an otherwise complete delivery effective while unpaid', async () => {
    const repo = new MemoryCustomerDeliveryRepository()
    const draft = await repo.create({ workspaceId: 'ws_effective_payment', companyName: 'Payment Gate Co', actorId: 'operator-1' })
    const paid = await repo.update({
      workspaceId: draft.workspaceId,
      id: draft.id,
      actorId: 'operator-1',
      expectedRevision: draft.revision,
      patch: { paymentStatus: 'paid', paymentDate: '2026-09-14', paymentEvidenceRefs: ['asset_payment_1'] },
    })
    const ready = await repo.update({
      workspaceId: paid.workspaceId,
      id: paid.id,
      actorId: 'operator-1',
      expectedRevision: paid.revision,
      patch: {
        contractNumber: 'C-1',
        contractRef: 'asset_ref_contract-1',
        projectOwner: 'owner',
        supportOwner: 'support',
        paymentDate: '2026-09-14',
        plannedGoLiveAt: '2026-10-01',
        customerProfileStatus: 'complete',
        trainingCompleted: true,
        trainingEvidenceRefs: ['asset_training_1'],
      },
    })
    const integrationItems = CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS.system_integration.map((itemKey, index) => ({ itemKey, completed: true, evidence: { asset_refs: [`asset_integration_${index}`] } }))
    await repo.updateChecklistItems!({ workspaceId: ready.workspaceId, deliveryId: ready.id, checklistKey: 'system_integration', items: integrationItems, actorId: 'operator-1', expectedRevision: ready.revision })
    const integrated = (await repo.get(ready.workspaceId, ready.id))!
    const acceptanceItems = CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS.functional_acceptance.map((itemKey, index) => ({ itemKey, completed: true, evidence: { asset_refs: [`asset_acceptance_${index}`] } }))
    await repo.updateChecklistItems!({ workspaceId: ready.workspaceId, deliveryId: ready.id, checklistKey: 'functional_acceptance', items: acceptanceItems, actorId: 'operator-1', expectedRevision: integrated.revision })
    await repo.addVideo({ workspaceId: ready.workspaceId, deliveryId: ready.id, actorId: 'operator-1', title: '交付视频', assetRef: 'asset://video-payment-gate' })
    const effective = (await repo.get(ready.workspaceId, ready.id))!
    expect(effective.effectiveAt).toBeTruthy()
    const unpaid = await repo.update({ workspaceId: ready.workspaceId, id: ready.id, actorId: 'operator-1', expectedRevision: effective.revision, patch: { paymentStatus: 'unpaid' } })
    expect(unpaid.effectiveAt).toBeNull()
  })

  it('persists batch checklist items and derives aggregate status without dropping evidence', async () => {
    const repo = new MemoryCustomerDeliveryRepository()
    const draft = await repo.create({ workspaceId: 'ws_batch', companyName: 'Batch Co', actorId: 'operator-1' })
    const paid = await repo.update({ workspaceId: draft.workspaceId, id: draft.id, actorId: 'operator-1', expectedRevision: draft.revision, patch: { paymentStatus: 'paid', paymentDate: '2026-09-14', paymentEvidenceRefs: ['asset_payment_1'] } })
    const items = CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS.system_integration.map((itemKey, i) => ({ itemKey, completed: true, evidence: { note: `证据-${i}`, asset_refs: [`asset_integration_${i}`] } }))
    const saved = await repo.updateChecklistItems!({ workspaceId: paid.workspaceId, deliveryId: paid.id, checklistKey: 'system_integration', items, actorId: 'operator-1', expectedRevision: paid.revision })
    expect(saved).toHaveLength(10)
    expect(saved[0]).toMatchObject({ itemKey: CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS.system_integration[0], completed: true, evidence: { note: '证据-0' } })
    expect((await repo.listChecklistItems!({ workspaceId: paid.workspaceId, deliveryId: paid.id, checklistKey: 'system_integration' }))).toHaveLength(10)
    expect((await repo.get(paid.workspaceId, paid.id))!.systemIntegrationStatus).toBe('complete')
  })

  it.each(['systemIntegrationStatus', 'functionalAcceptanceStatus'].flatMap(field =>
    ['complete', 'incomplete'].map(value => ({ field, value })),
  ))('rejects ordinary $field=$value patches in both repositories without mutation', async ({ field, value }) => {
    const memory = new MemoryCustomerDeliveryRepository()
    const draft = await memory.create({ workspaceId: 'ws_no_scalar', companyName: 'No scalar', actorId: 'operator-1' })
    const patch = { [field]: value, companyName: 'must not be saved' } as CustomerDeliveryPatch
    await expect(memory.update({ workspaceId: draft.workspaceId, id: draft.id, actorId: 'operator-1', expectedRevision: draft.revision, patch }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(await memory.get(draft.workspaceId, draft.id)).toEqual(draft)
    const client = new RecordingClient()
    const postgres = new PostgresCustomerDeliveryRepository(new RecordingPool(client))
    await expect(postgres.update({ workspaceId: 'ws_pg', id: 'cd_pg', actorId: 'operator-1', expectedRevision: 4, patch }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(client.calls).toEqual([])
  })

  it.each(['payment-first', 'training-first'])('allows legacy stepwise repair (%s) without trusting old aggregate booleans', async order => {
    const repo = new MemoryCustomerDeliveryRepository()
    const draft = await repo.create({ workspaceId: `ws_legacy_${order}`, companyName: 'Legacy', actorId: 'operator-1' })
    const stored = legacyRow(repo, draft)
    const storedBefore = structuredClone(stored)
    expect((await repo.get(draft.workspaceId, draft.id))!.effectiveAt).toBeNull()
    expect((await repo.list(draft.workspaceId))[0]!.effectiveAt).toBeNull()
    expect(stored).toEqual(storedBefore)
    let current = await repo.update({ workspaceId: draft.workspaceId, id: draft.id, actorId: 'operator-1',
      expectedRevision: draft.revision, patch: { companyName: 'Legacy metadata repair' } })
    expect(current).toMatchObject({ paymentStatus: 'paid', trainingCompleted: true, paymentEvidenceRefs: [], trainingEvidenceRefs: [], effectiveAt: null })
    const repairs = order === 'payment-first'
      ? [{ paymentEvidenceRefs: ['asset_payment'] }, { trainingEvidenceRefs: ['asset_training'] }]
      : [{ trainingEvidenceRefs: ['asset_training'] }, { paymentEvidenceRefs: ['asset_payment'] }]
    for (const patch of repairs) {
      current = await repo.update({ workspaceId: draft.workspaceId, id: draft.id, actorId: 'operator-1', expectedRevision: current.revision, patch })
      expect(current.effectiveAt).toBeNull()
    }
    current = await completeChecklist(repo, current, 'system_integration')
    current = await completeChecklist(repo, current, 'functional_acceptance')
    expect(current.effectiveAt).toBeNull()
    await repo.addVideo({ workspaceId: current.workspaceId, deliveryId: current.id, actorId: 'operator-1', title: 'Repository-only video reference', assetRef: 'asset_video' })
    expect((await repo.get(current.workspaceId, current.id))!.effectiveAt).not.toBeNull()
  })

  it('stores previous items and evidence in the memory batch audit before snapshot', async () => {
    const events: Array<{ action: string; before?: Record<string, unknown> }> = []
    const repo = new MemoryCustomerDeliveryRepository(event => { events.push(event) })
    const draft = await repo.create({ workspaceId: 'ws_batch_before', companyName: 'Batch before', actorId: 'operator-1' })
    const paid = await repo.update({ workspaceId: draft.workspaceId, id: draft.id, actorId: 'operator-1', expectedRevision: draft.revision,
      patch: { paymentStatus: 'paid', paymentDate: '2026-09-14', paymentEvidenceRefs: ['asset_payment'] } })
    const integrated = await completeChecklist(repo, paid, 'system_integration')
    const previous = await repo.listChecklistItems({ workspaceId: integrated.workspaceId, deliveryId: integrated.id, checklistKey: 'system_integration' })
    await repo.updateChecklistItems({ workspaceId: integrated.workspaceId, deliveryId: integrated.id, checklistKey: 'system_integration',
      actorId: 'operator-1', expectedRevision: integrated.revision,
      items: previous.map(item => ({ itemKey: item.itemKey, completed: false, evidence: { note: 'reopened without claiming scan success' } })),
    })
    const before = events.at(-1)!.before!
    expect(before.revision).toBe(integrated.revision)
    expect(before.items).toEqual(expect.arrayContaining(previous))
    expect((before.items as unknown[]).length).toBe(10)
    expect((await repo.get(integrated.workspaceId, integrated.id))!.systemIntegrationStatus).toBe('incomplete')
  })

  it('rejects clearing a paid date, but preserves an explicit null when revoked to unpaid', async () => {
    const repo = new MemoryCustomerDeliveryRepository()
    const draft = await repo.create({ workspaceId: 'ws_null_date', companyName: 'Null date', actorId: 'operator-1' })
    const paid = await repo.update({ workspaceId: draft.workspaceId, id: draft.id, actorId: 'operator-1', expectedRevision: draft.revision,
      patch: { ...profile, paymentStatus: 'paid', paymentDate: '2026-09-14', paymentEvidenceRefs: ['asset_payment'] } })
    await expect(repo.update({ workspaceId: paid.workspaceId, id: paid.id, actorId: 'operator-1', expectedRevision: paid.revision,
      patch: { paymentDate: null } })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(await repo.get(paid.workspaceId, paid.id)).toEqual(paid)
    const unpaid = await repo.update({ workspaceId: paid.workspaceId, id: paid.id, actorId: 'operator-1', expectedRevision: paid.revision,
      patch: { paymentStatus: 'unpaid', paymentDate: null } })
    expect(unpaid).toMatchObject({ paymentStatus: 'unpaid', paymentDate: null, effectiveAt: null })
    expect(await repo.get(unpaid.workspaceId, unpaid.id)).toEqual(unpaid)

    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue(postgresRow()); client.enqueue()
    await expect(new PostgresCustomerDeliveryRepository(new RecordingPool(client)).update({ workspaceId: 'ws_pg', id: 'cd_pg', actorId: 'operator-1',
      expectedRevision: 4, patch: { paymentDate: null } })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(client.calls.some(call => call.text.startsWith('UPDATE'))).toBe(false)
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')

    const accepted = new RecordingClient()
    const cleared = postgresRow({ payment_status: 'unpaid', payment_date: null, revision: 5 })
    accepted.enqueue(); accepted.enqueue(); accepted.enqueue(postgresRow()); accepted.enqueue(); accepted.enqueue(cleared)
    accepted.enqueue(cleared); accepted.enqueue(); accepted.enqueue(); accepted.enqueue()
    accepted.enqueue(cleared); accepted.enqueue(); accepted.enqueue(); accepted.enqueue()
    const persisted = await new PostgresCustomerDeliveryRepository(new RecordingPool(accepted)).update({
      workspaceId: 'ws_pg', id: 'cd_pg', actorId: 'operator-1', expectedRevision: 4,
      patch: { paymentStatus: 'unpaid', paymentDate: null },
    })
    expect(persisted).toMatchObject({ paymentStatus: 'unpaid', paymentDate: null, effectiveAt: null, revision: 5 })
    const write = accepted.calls.find(call => call.text.includes('payment_date=$'))!
    expect(write.values?.slice(-2)).toEqual(['unpaid', null])
    const audit = accepted.calls.find(call => call.text.includes('INSERT INTO workspace_operation_audit'))!
    expect(JSON.parse(String(audit.values?.[6]))).toMatchObject({ paymentStatus: 'paid', paymentDate: '2026-09-14' })
    expect(JSON.parse(String(audit.values?.[7]))).toMatchObject({ paymentStatus: 'unpaid', paymentDate: null })
    expect(accepted.calls.at(-1)?.text).toBe('COMMIT')
  })

  it.each(['ready', 'missing-key', 'unknown-key', 'incomplete-item', 'missing-item-evidence', 'payment', 'training', 'video', 'unpaid'])(
    'projects effectiveAt for %s from PostgreSQL-shaped stored row fixtures', async state => {
      const client = new EvidenceTransactionClient()
      const row = postgresRow({ effective_at: '2026-09-13T00:00:00.000Z',
        ...(state === 'payment' ? { payment_evidence_refs: [] } : {}),
        ...(state === 'training' ? { training_evidence_refs: [] } : {}),
        ...(state === 'unpaid' ? { payment_status: 'unpaid' } : {}),
      })
      const items = Object.entries(CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS).flatMap(([checklistKey, keys]) => keys.map(itemKey => ({
        workspace_id: row.workspace_id, delivery_id: row.id, checklist_key: checklistKey, item_key: String(itemKey), completed: true,
        evidence: { asset_refs: ['asset_repository_reference'] }, completed_by_actor_id: 'operator-1',
        completed_at: '2026-09-14T00:00:00.000Z', updated_at: '2026-09-14T00:00:00.000Z', revision: 1,
      })))
      if (state === 'missing-key') items.pop()
      if (state === 'unknown-key') items[0]!.item_key = 'not a required checklist key'
      if (state === 'incomplete-item') items[0]!.completed = false
      if (state === 'missing-item-evidence') items[0]!.evidence = { asset_refs: [] }
      client.row = row
      client.videos = state === 'video' ? [] : [postgresVideo()]
      client.items = items
      const result = await new PostgresCustomerDeliveryRepository(new RecordingPool(client)).get('ws_pg', 'cd_pg')
      expect(result?.effectiveAt).toBe(['ready', 'missing-item-evidence', 'payment', 'training'].includes(state) ? row.effective_at : null)
      expect(result?.systemIntegrationStatus).toBe('complete')
      expect(row.effective_at).toBe('2026-09-13T00:00:00.000Z')
      expect(client.calls.some(call => call.text.startsWith('UPDATE'))).toBe(false)
      const deliveryRead = client.calls.findIndex(call => call.text.includes('SELECT * FROM workspace_customer_deliveries'))
      const videoRead = client.calls.findIndex(call => call.text.includes('SELECT * FROM workspace_customer_delivery_videos'))
      expect(client.calls[deliveryRead]!.text).not.toMatch(/FOR (UPDATE|SHARE)/u)
      expect(videoRead).toBeGreaterThan(deliveryRead)
      const parentLock = client.calls.findIndex(call => call.text.includes('FOR SHARE'))
      expect(parentLock).toBeGreaterThan(videoRead)
      expect(client.calls.some(call => call.text.includes('delivery_evidence_read_recheck_items'))).toBe(true)
      expect(client.calls.at(-1)?.text).toBe('COMMIT')
    },
  )

  it('treats empty memory patches as revision-checked no-ops without adding audit entries', async () => {
    const events: unknown[] = []
    const repo = new MemoryCustomerDeliveryRepository(event => { events.push(event) })
    const draft = await repo.create({ workspaceId: 'ws_empty_patch', companyName: 'No-op', actorId: 'operator-1' })
    for (const patch of [{}, { companyName: undefined }]) {
      expect(await repo.update({ workspaceId: draft.workspaceId, id: draft.id, actorId: 'operator-1', expectedRevision: draft.revision, patch })).toEqual(draft)
      expect(events).toHaveLength(1)
    }
    await expect(repo.update({ workspaceId: draft.workspaceId, id: draft.id, actorId: 'operator-1', expectedRevision: draft.revision + 1, patch: {} }))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(await repo.get(draft.workspaceId, draft.id)).toEqual(draft)
    expect(events).toHaveLength(1)
  })

  it('rechecks list parent and child snapshots under a shared lock in a separate per-delivery transaction', async () => {
    const client = new EvidenceTransactionClient()
    client.row.effective_at = '2026-09-13T00:00:00.000Z'
    client.items = []
    const result = await new PostgresCustomerDeliveryRepository(new RecordingPool(client)).list('ws_pg')
    expect(result[0]?.effectiveAt).toBeNull()
    expect(client.calls[2]!.text).toContain('delivery_evidence_list_ids')
    expect(client.calls[3]!.text).toBe('COMMIT')
    expect(client.calls[4]!.text).toBe('BEGIN')
    const lock = client.calls.findIndex(call => call.text.includes('FOR SHARE'))
    expect(client.calls[lock]!.text).toContain('delivery_evidence_read_recheck')
    expect(client.calls[lock + 1]!.text).toContain('delivery_evidence_read_recheck_videos')
    expect(client.calls[lock + 2]!.text).toContain('delivery_evidence_read_recheck_items')
    expect(client.calls.at(-1)?.text).toBe('COMMIT')
  })

  it('preserves actual old videos and historical effectiveAt in ordinary PostgreSQL update audits', async () => {
    const client = new RecordingClient()
    const historical = postgresRow({ effective_at: '2026-09-13T00:00:00.000Z' })
    const saved = { ...historical, company_name: 'Renamed', revision: 5 }
    const final = { ...saved, effective_at: null }
    const video = { id: 'video_1', workspace_id: 'ws_pg', delivery_id: 'cd_pg', title: 'Existing', asset_ref: 'asset_video',
      sort_order: 0, uploaded_by_actor_id: 'operator-1', created_at: '2026-09-14T00:00:00.000Z', deleted_at: null }
    client.enqueue(); client.enqueue(); client.enqueue(historical); client.enqueue(video); client.enqueue(saved)
    client.enqueue(saved); client.enqueue(video); client.enqueue(); client.enqueue()
    client.enqueue(final); client.enqueue(video); client.enqueue(); client.enqueue()
    const result = await new PostgresCustomerDeliveryRepository(new RecordingPool(client)).update({ workspaceId: 'ws_pg', id: 'cd_pg',
      actorId: 'operator-1', expectedRevision: 4, patch: { companyName: 'Renamed' } })
    expect(result.effectiveAt).toBeNull()
    const audit = client.calls.find(call => call.text.includes('INSERT INTO workspace_operation_audit'))!
    const before = JSON.parse(String(audit.values?.[6]))
    const after = JSON.parse(String(audit.values?.[7]))
    expect(before.videos).toHaveLength(1)
    expect(before.videos).toEqual(after.videos)
    expect(before.effectiveAt).toBe(historical.effective_at)
    expect(after).toMatchObject({ companyName: 'Renamed', effectiveAt: null, revision: 5 })
    const lock = client.calls.findIndex(call => call.text.includes('FOR UPDATE'))
    const oldVideoRead = client.calls.findIndex((call, index) => index > lock && call.text.includes('workspace_customer_delivery_videos'))
    const update = client.calls.findIndex(call => call.text.startsWith('UPDATE workspace_customer_deliveries SET company_name='))
    expect(oldVideoRead).toBeGreaterThan(lock)
    expect(update).toBeGreaterThan(oldVideoRead)
    expect(client.calls.some(call => call.text.includes('assert_customer_delivery_evidence_asset'))).toBe(false)
  })

  it('does not reactivate a structurally complete delivery when existing asset evidence is blocked or unbound', async () => {
    const client = new RejectingVideoEvidenceClient()
    const row = postgresRow({ effective_at: null })
    const saved = { ...row, company_name: 'Renamed', revision: 5 }
    const video = { id: 'video_1', workspace_id: 'ws_pg', delivery_id: 'cd_pg', title: 'Existing', asset_ref: 'asset_video_blocked',
      sort_order: 0, uploaded_by_actor_id: 'operator-1', created_at: '2026-09-14T00:00:00.000Z', deleted_at: null }
    const items = Object.entries(CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS).flatMap(([checklistKey, keys]) => keys.map(itemKey => ({
      workspace_id: 'ws_pg', delivery_id: 'cd_pg', checklist_key: checklistKey, item_key: String(itemKey), completed: true,
      evidence: { asset_refs: [`asset_${checklistKey}_${String(itemKey)}`] }, completed_by_actor_id: 'operator-1',
      completed_at: '2026-09-14T00:00:00.000Z', updated_at: '2026-09-14T00:00:00.000Z', revision: 1,
    })))
    client.preflight = { parent: row, videos: [video], items }
    client.enqueue(); client.enqueue(); client.enqueue(row); client.enqueue(video); client.enqueue(saved)
    client.enqueue(saved); client.enqueue(video); client.enqueue(...items)

    await expect(new PostgresCustomerDeliveryRepository(new RecordingPool(client)).update({
      workspaceId: 'ws_pg', id: 'cd_pg', actorId: 'operator-1', expectedRevision: 4, patch: { companyName: 'Renamed' },
    })).rejects.toThrow('blocked or unbound evidence asset')

    const assertions = client.calls.filter(call => call.text.includes('assert_customer_delivery_evidence_asset'))
    expect(assertions.map(call => call.values?.slice(2))).toEqual([
      ['contract', 'asset_ref_repository_contract'],
      ['payment', 'asset_payment'],
      ['training', 'asset_training'],
      ...CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS.system_integration.map(itemKey => ['system_integration', `asset_system_integration_${itemKey}`]),
      ...CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS.functional_acceptance.map(itemKey => ['functional_acceptance', `asset_functional_acceptance_${itemKey}`]),
      ['video', 'asset_video_blocked'],
    ].sort((a, b) => a[1]! < b[1]! ? -1 : a[1]! > b[1]! ? 1 : a[0]! < b[0]! ? -1 : 1))
    expect(assertions.some(call => call.values?.[2] === 'contract')).toBe(true)
    expect(client.calls.some(call => call.text.includes('FOR UPDATE'))).toBe(false)
    expect(client.calls.some(call => call.text.includes('SET effective_at=CASE'))).toBe(false)
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
  })

  it('records the persisted checklist item as the audit before snapshot', async () => {
    const client = new RecordingClient()
    const previous = {
      workspace_id: 'ws_pg_audit', delivery_id: 'cd_1', checklist_key: 'system_integration',
      item_key: '店铺连接', completed: false, evidence: { note: '旧证据' },
      completed_by_actor_id: null, completed_at: null, revision: 2,
      updated_at: '2026-09-14T00:00:00.000Z',
    }
    const saved = { ...previous, completed: true, evidence: { note: '新证据', asset_refs: ['asset_integration_1'] },
      completed_by_actor_id: 'operator-1', completed_at: '2026-09-14T00:01:00.000Z', revision: 3,
      updated_at: '2026-09-14T00:01:00.000Z' }
    const delivery = {
      id: 'cd_1', workspace_id: 'ws_pg_audit', company_name: 'Acme', contract_number: null,
      payment_status: 'paid', contract_ref: null, project_owner: null, support_owner: null,
      payment_date: '2026-09-14', payment_evidence_refs: ['asset_payment_1'], planned_go_live_at: null,
      customer_profile_status: 'incomplete', system_integration_status: 'incomplete', functional_acceptance_status: 'incomplete',
      training_completed: false, training_evidence_refs: [], effective_at: null, revision: 5,
      created_by_actor_id: 'operator-1', updated_by_actor_id: 'operator-1',
      created_at: '2026-09-14T00:00:00.000Z', updated_at: '2026-09-14T00:01:00.000Z',
    }
    // BEGIN, scope, delivery lock, previous item, upsert, current items, status update,
    // effective-time recalculation, audit, COMMIT.
    client.enqueue(); client.enqueue(); client.enqueue({ ...delivery, revision: 4 })
    client.enqueue(previous); client.enqueue(saved); client.enqueue(saved); client.enqueue()
    client.enqueue(delivery); client.enqueue(); client.enqueue(saved); client.enqueue(); client.enqueue(); client.enqueue()
    const repo = new PostgresCustomerDeliveryRepository(new RecordingPool(client))
    await repo.updateChecklistItem({ workspaceId: 'ws_pg_audit', deliveryId: 'cd_1', checklistKey: 'system_integration', itemKey: '店铺连接', completed: true, evidence: { note: '新证据', asset_refs: ['asset_integration_1'] }, actorId: 'operator-1', expectedRevision: 4 })
    const audit = client.calls.find((call) => call.text.includes('INSERT INTO workspace_operation_audit'))
    expect(audit).toBeDefined()
    expect(client.calls.find(call => call.text.includes('assert_customer_delivery_evidence_asset'))?.values)
      .toEqual(['ws_pg_audit', 'cd_1', 'system_integration', 'asset_integration_1'])
    expect(audit?.values?.[0]).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u)
    const statusWrite = client.calls.findIndex(call => call.text.includes('SET system_integration_status='))
    const effectiveWrite = client.calls.findIndex(call => call.text.includes('SET effective_at=CASE'))
    expect(effectiveWrite).toBeGreaterThan(statusWrite)
    expect(JSON.parse(String(audit?.values?.[6]))).toMatchObject({ completed: false, revision: 2, evidence: { note: '旧证据' } })
    expect(JSON.parse(String(audit?.values?.[7]))).toMatchObject({ completed: true, revision: 3, evidence: { note: '新证据' } })
  })
})
