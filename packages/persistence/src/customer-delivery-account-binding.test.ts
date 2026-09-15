import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MemoryCustomerDeliveryRepository, PostgresCustomerDeliveryRepository,
  type CustomerDeliveryAccountDirectory, type CustomerDeliveryAccountBindingInput,
  type CustomerDeliveryBindableAccount } from './customer-delivery-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

function memoryFixture() {
  const account: CustomerDeliveryBindableAccount & { bindable: boolean } = { workspaceId: 'ws-a', accountId: randomUUID(), identityId: randomUUID(), login: 'merchant@example.test', bindable: true }
  const records = new Map([[account.accountId, account]])
  const events: Record<string, unknown>[] = []
  const directory: CustomerDeliveryAccountDirectory = {
    async list(input) { return { items: [...records.values()].filter(row => row.workspaceId === input.workspaceId && row.bindable)
      .map(({ bindable: _bindable, ...row }) => row).slice(0, input.limit ?? 20) } },
    async get(input) { return records.get(input.accountId) ?? null },
  }
  const repo = new MemoryCustomerDeliveryRepository(event => { events.push(event as unknown as Record<string, unknown>) }, { accountDirectory: directory })
  return { repo, account, records, directory, events }
}
const bind = (deliveryId: string, targetAccountId: string, expectedRevision = 1): CustomerDeliveryAccountBindingInput =>
  ({ workspaceId: 'ws-a', deliveryId, targetAccountId, expectedRevision, actorId: 'ops-owner', reason: '客户已确认绑定登录账号' })

describe('customer delivery single-account binding', () => {
  it('keeps legacy/new records unbound and uses identityId rather than the different accountId', async () => {
    const { repo, account, events } = memoryFixture()
    const delivery = await repo.create({ workspaceId: 'ws-a', companyName: 'Customer A', actorId: 'operator' })
    expect(delivery).toMatchObject({ targetAccountId: null, targetIdentityId: null, targetAccountLogin: null, revision: 1 })
    expect(await repo.getByIdentity('ws-a', account.identityId)).toBeNull()
    const result = await repo.bindAccount(bind(delivery.id, account.accountId))
    expect(result).toMatchObject({ targetAccountId: account.accountId, targetIdentityId: account.identityId,
      targetAccountLogin: account.login, revision: 2, effectiveAt: null, paymentStatus: 'unpaid' })
    expect(await repo.getByIdentity('ws-a', account.accountId)).toBeNull()
    expect(await repo.getByIdentity('ws-b', account.identityId)).toBeNull()
    expect(await repo.getByIdentity('ws-a', account.identityId)).toMatchObject({ id: delivery.id, effectiveAt: null })
    expect(events.filter(event => event.action === 'customer_delivery.account.bind')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ actorId: 'ops-owner', reason: '客户已确认绑定登录账号',
      before: { targetAccountId: null, targetIdentityId: null }, after: { targetAccountId: account.accountId, targetIdentityId: account.identityId } })
  })
  it('reads the current login after renaming or stopping an account without reactivating it', async () => {
    const { repo, account } = memoryFixture()
    const delivery = await repo.create({ workspaceId: 'ws-a', companyName: 'Customer', actorId: 'operator' })
    await repo.bindAccount(bind(delivery.id, account.accountId))
    account.login = 'renamed@example.test'; account.bindable = false
    expect(await repo.get('ws-a', delivery.id)).toMatchObject({ targetAccountLogin: account.login, revision: 2, paymentStatus: 'unpaid' })
    expect(account.bindable).toBe(false)
    expect(await repo.listBindableAccounts({ workspaceId: 'ws-a' })).toEqual({ items: [] })
  })
  it('rechecks the delivery snapshot after asynchronous login resolution', async () => {
    const { repo, account, directory } = memoryFixture()
    const delivery = await repo.create({ workspaceId: 'ws-a', companyName: 'Before', actorId: 'operator' })
    await repo.bindAccount(bind(delivery.id, account.accountId))
    let changed = false
    directory.get = async () => {
      if (!changed) { changed = true; await repo.update({ workspaceId: 'ws-a', id: delivery.id, actorId: 'ops',
        expectedRevision: 2, patch: { companyName: 'Changed during account read' } }) }
      return account
    }
    expect(await repo.getByIdentity('ws-a', account.identityId)).toMatchObject({ revision: 3, companyName: 'Changed during account read' })
    directory.get = async () => null
    await expect(repo.getByIdentity('ws-a', account.identityId)).rejects.toMatchObject({ code: 'ACCOUNT_DIRECTORY_UNAVAILABLE' })
  })
  it.each(['unavailable', 'inactive', 'cross-workspace', 'wrong-account', 'missing-identity'] as const)('rejects %s candidates without an audit or revision change', async reason => {
    const { repo, account, directory, events } = memoryFixture()
    const delivery = await repo.create({ workspaceId: 'ws-a', companyName: 'Customer', actorId: 'operator' })
    if (reason === 'unavailable') directory.get = async () => null
    if (reason === 'inactive') account.bindable = false
    if (reason === 'cross-workspace') account.workspaceId = 'ws-b'
    if (reason === 'wrong-account') directory.get = async () => ({ ...account, accountId: randomUUID() })
    if (reason === 'missing-identity') account.identityId = ''
    await expect(repo.bindAccount(bind(delivery.id, account.accountId))).rejects.toMatchObject({ code: 'ACCOUNT_NOT_BINDABLE' })
    expect(await repo.get('ws-a', delivery.id)).toMatchObject({ revision: 1, targetAccountId: null })
    expect(events).toHaveLength(1)
  })
  it('rejects stale revision, rebinding, and duplicate identity across different records', async () => {
    const { repo, account } = memoryFixture()
    const a = await repo.create({ workspaceId: 'ws-a', companyName: 'A', actorId: 'operator' })
    const b = await repo.create({ workspaceId: 'ws-a', companyName: 'B', actorId: 'operator' })
    await expect(repo.bindAccount(bind(a.id, account.accountId, 2))).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    await repo.bindAccount(bind(a.id, account.accountId))
    await expect(repo.bindAccount(bind(a.id, account.accountId, 2))).rejects.toMatchObject({ code: 'ACCOUNT_ALREADY_BOUND' })
    await expect(repo.bindAccount(bind(b.id, account.accountId))).rejects.toMatchObject({ code: 'ACCOUNT_ALREADY_BOUND' })
    await expect(repo.update({ workspaceId: 'ws-a', id: a.id, actorId: 'ops', expectedRevision: 2,
      patch: { targetAccountId: null } as never })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
  it('serializes competing binds and makes the losing record remain unbound', async () => {
    const { repo, account, events } = memoryFixture()
    const a = await repo.create({ workspaceId: 'ws-a', companyName: 'A', actorId: 'operator' })
    const b = await repo.create({ workspaceId: 'ws-a', companyName: 'B', actorId: 'operator' })
    const results = await Promise.allSettled([repo.bindAccount(bind(a.id, account.accountId)), repo.bindAccount(bind(b.id, account.accountId))])
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect((await repo.list('ws-a')).filter(row => row.targetIdentityId)).toHaveLength(1)
    expect(events.filter(event => event.action === 'customer_delivery.account.bind')).toHaveLength(1)
  })
  it('rolls back binding and releases the mutation boundary when the audit fails', async () => {
    const { directory, account } = memoryFixture()
    const repo = new MemoryCustomerDeliveryRepository(event => { if (event.action.endsWith('.bind')) throw new Error('audit unavailable') }, { accountDirectory: directory })
    const delivery = await repo.create({ workspaceId: 'ws-a', companyName: 'A', actorId: 'operator' })
    await expect(repo.bindAccount(bind(delivery.id, account.accountId))).rejects.toThrow('audit unavailable')
    expect(await repo.get('ws-a', delivery.id)).toMatchObject({ revision: 1, targetAccountId: null })
    await expect(repo.update({ workspaceId: 'ws-a', id: delivery.id, actorId: 'ops', expectedRevision: 1, patch: { companyName: 'Updated' } })).resolves.toMatchObject({ revision: 2 })
  })
  it('does not expose a pending binding or permit a conflicting edit during its audit', async () => {
    const { directory, account } = memoryFixture()
    let finish!: () => void; let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const audited = new Promise<void>(resolve => { finish = resolve })
    const repo = new MemoryCustomerDeliveryRepository(async event => { if (event.action.endsWith('.bind')) { started(); await audited } }, { accountDirectory: directory })
    const delivery = await repo.create({ workspaceId: 'ws-a', companyName: 'A', actorId: 'operator' })
    const pending = repo.bindAccount(bind(delivery.id, account.accountId)); await entered
    expect(await repo.getByIdentity('ws-a', account.identityId)).toBeNull()
    await expect(repo.update({ workspaceId: 'ws-a', id: delivery.id, actorId: 'ops', expectedRevision: 1, patch: { companyName: 'Other' } })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    finish(); await pending
    expect(await repo.getByIdentity('ws-a', account.identityId)).toMatchObject({ companyName: 'A', revision: 2 })
  })
  it('fails closed without a directory while preserving unbound legacy reads', async () => {
    const repo = new MemoryCustomerDeliveryRepository()
    await expect(repo.listBindableAccounts({ workspaceId: 'ws-a' })).rejects.toMatchObject({ code: 'ACCOUNT_DIRECTORY_UNAVAILABLE' })
    await expect(repo.bindAccount(bind('delivery', randomUUID()))).rejects.toMatchObject({ code: 'ACCOUNT_DIRECTORY_UNAVAILABLE' })
    expect(await repo.getByIdentity('ws-a', randomUUID())).toBeNull()
  })
  it.each([{ limit: 0 }, { limit: 51 }, { limit: 1.1 }, { search: 'a'.repeat(129) }, { cursor: 'bad cursor' }])('rejects malformed search/page input %j', async input => {
    await expect(memoryFixture().repo.listBindableAccounts({ workspaceId: 'ws-a', ...input })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

// A strict SQL-protocol double, not evidence of PostgreSQL RLS or real scans.
class BindingClient implements SqlClient {
  calls: { text: string; values: readonly unknown[] }[] = []
  account: CustomerDeliveryBindableAccount = { workspaceId: 'ws-a', accountId: randomUUID(), identityId: randomUUID(), login: 'merchant@example.test' }
  accounts: CustomerDeliveryBindableAccount[] = []
  row: Record<string, any> = { id: 'cd-a', workspace_id: 'ws-a', company_name: 'A', target_account_id: null, target_identity_id: null,
    payment_status: 'unpaid', payment_evidence_refs: [], training_evidence_refs: [], revision: 1,
    created_at: '2026-09-15T00:00:00.000Z', updated_at: '2026-09-15T00:00:00.000Z' }
  eligible = true
  failAudit = false
  loginUnavailable = false
  private snapshot: Record<string, any> | undefined
  async query<T>(text: string, values: readonly unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ text, values })
    const rows = (...value: any[]) => ({ rows: structuredClone(value) as T[] })
    if (text === 'BEGIN') { this.snapshot = structuredClone(this.row); return rows() }
    if (text === 'ROLLBACK') { this.row = this.snapshot!; return rows() }
    if (text === 'COMMIT' || text.includes('set_config(')) return rows()
    if (text.includes('delivery_bindable_accounts')) return rows(...this.accounts)
    if (text.includes('delivery_account_login')) return this.loginUnavailable ? rows() : rows({ login: this.account.login })
    if (text.includes('delivery_account_bind_target')) return this.eligible ? rows(this.account) : rows()
    if (text.includes('FROM workspace_customer_deliveries') && text.startsWith('SELECT')) {
      const key = text.includes('target_identity_id=$2') ? 'target_identity_id' : 'id'
      return this.row.workspace_id === values[0] && this.row[key] === values[1] ? rows(this.row) : rows()
    }
    if (text.startsWith('SELECT') && /FROM workspace_customer_delivery_(videos|checklist_items)/u.test(text)) return rows()
    if (text.includes('delivery_account_bind_write')) {
      if (this.row.revision !== values[5] || this.row.target_account_id !== null) return rows()
      Object.assign(this.row, { target_account_id: values[2], target_identity_id: values[3], revision: this.row.revision + 1, updated_by_actor_id: values[4] })
      return rows(this.row)
    }
    if (text.startsWith('INSERT INTO workspace_operation_audit')) { if (this.failAudit) throw new Error('audit failure'); return rows() }
    throw new Error(`Unexpected SQL: ${text}`)
  }
  release() {}
}
function pgFixture() { const client = new BindingClient(); const pool: SqlPool = { connect: async () => client }; return { client, repo: new PostgresCustomerDeliveryRepository(pool) } }

describe('PostgreSQL binding protocol', () => {
  it('binds through scoped target locking and records its audit in the same transaction', async () => {
    const { repo, client } = pgFixture()
    expect(await repo.bindAccount(bind('cd-a', client.account.accountId))).toMatchObject({ targetAccountId: client.account.accountId, targetIdentityId: client.account.identityId, targetAccountLogin: client.account.login, revision: 2 })
    const sql = client.calls.map(call => call.text)
    expect(sql.filter(value => value === 'BEGIN')).toHaveLength(1)
    expect(sql).toContain("SELECT set_config('app.workspace_id', $1, true)")
    expect(sql).toContain("SELECT set_config('app.platform_scope', 'platform_ops', true)")
    expect(sql.findIndex(value => value.includes('delivery_account_bind_target'))).toBeLessThan(sql.findIndex(value => value.includes('delivery_account_bind_write')))
    expect(sql.findIndex(value => value.startsWith('INSERT INTO workspace_operation_audit'))).toBeLessThan(sql.indexOf('COMMIT'))
  })
  it('rolls the row back when the atomic audit fails', async () => {
    const { repo, client } = pgFixture(); client.failAudit = true
    await expect(repo.bindAccount(bind('cd-a', client.account.accountId))).rejects.toThrow('audit failure')
    expect(client.row).toMatchObject({ target_account_id: null, target_identity_id: null, revision: 1 })
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
  })
  it('does not write or audit a target rejected by the locked eligibility query', async () => {
    const { repo, client } = pgFixture(); client.eligible = false
    await expect(repo.bindAccount(bind('cd-a', client.account.accountId))).rejects.toMatchObject({ code: 'ACCOUNT_NOT_BINDABLE' })
    expect(client.calls.some(call => call.text.includes('delivery_account_bind_write') || call.text.startsWith('INSERT INTO workspace_operation_audit'))).toBe(false)
    expect(client.row.revision).toBe(1)
  })
  it('does not reinterpret missing table privileges as an unbound legacy identity', async () => {
    const { repo, client } = pgFixture()
    const originalQuery = client.query.bind(client)
    client.query = async (text, values) => {
      if (text.includes('delivery_evidence_read_parent')) throw Object.assign(new Error('permission denied'), { code: '42501' })
      return originalQuery(text, values)
    }
    await expect(repo.getByIdentity('ws-a', client.account.identityId)).rejects.toMatchObject({ code: '42501' })
  })
  it('returns exact identity only and preserves read failures instead of apparent legacy access', async () => {
    const { repo, client } = pgFixture()
    await repo.bindAccount(bind('cd-a', client.account.accountId))
    expect(await repo.getByIdentity('ws-b', client.account.identityId)).toBeNull()
    expect(await repo.getByIdentity('ws-a', client.account.accountId)).toBeNull()
    expect(await repo.getByIdentity('ws-a', client.account.identityId)).toMatchObject({ id: 'cd-a', effectiveAt: null })
    client.loginUnavailable = true
    await expect(repo.getByIdentity('ws-a', client.account.identityId)).rejects.toMatchObject({ code: 'ACCOUNT_DIRECTORY_UNAVAILABLE' })
    expect(client.calls.some(call => call.text.includes('delivery_evidence_read_recheck'))).toBe(true)
  })
  it('requests a bounded page and binds cursors to the workspace and search', async () => {
    const { repo, client } = pgFixture()
    client.accounts = [client.account, { ...client.account, accountId: randomUUID(), login: 'next@example.test' }]
    const page = await repo.listBindableAccounts({ workspaceId: 'ws-a', search: 'EXAMPLE', limit: 1 })
    expect(page.items).toHaveLength(1); expect(page.nextCursor).toBeTypeOf('string')
    expect(client.calls.find(call => call.text.includes('delivery_bindable_accounts'))?.values).toEqual(['ws-a', 'example', null, null, 2])
    await expect(repo.listBindableAccounts({ workspaceId: 'ws-b', search: 'example', cursor: page.nextCursor })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(repo.listBindableAccounts({ workspaceId: 'ws-a', search: 'changed', cursor: page.nextCursor })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await repo.listBindableAccounts({ workspaceId: 'ws-a', search: 'example', cursor: page.nextCursor, limit: 1 })
    expect(client.calls.filter(call => call.text.includes('delivery_bindable_accounts')).at(-1)?.values).toEqual(['ws-a', 'example', client.account.login, client.account.accountId, 2])
  })
})
