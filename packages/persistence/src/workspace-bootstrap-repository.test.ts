import { describe, expect, it } from 'vitest'
import { MemoryMembersRepository } from './members-repository.js'
import { MemoryOperationsRepository } from './operations-repository.js'
import type { SqlClient, SqlPool, SqlQueryResult } from './repository.js'
import {
  MemoryWorkspaceBootstrapRepository,
  PostgresWorkspaceBootstrapRepository,
  WorkspaceBootstrapError,
} from './workspace-bootstrap-repository.js'

/**
 * A pool stand-in that records the SQL it was asked to run, so a test can
 * assert which credential received a statement. `identity` is the row the
 * `platform_identities` probe returns; `denyIdentityRead` reproduces the
 * runtime role's 42501 on that table (`infra/local/ensure-app-role.sql`).
 */
class StubPool implements SqlPool {
  readonly calls: string[] = []
  constructor(private readonly identity?: Record<string, unknown>, private readonly denyIdentityRead = false) {}
  async connect(): Promise<SqlClient> {
    const { calls, identity, denyIdentityRead } = this
    return {
      async query<Row = Record<string, unknown>>(text: string): Promise<SqlQueryResult<Row>> {
        calls.push(text)
        if (text.includes('platform_identities')) {
          if (denyIdentityRead) throw Object.assign(new Error('permission denied for table platform_identities'), { code: '42501' })
          return { rows: (identity ? [identity] : []) as Row[] }
        }
        return { rows: [] }
      },
      release() {},
    }
  }
}

const bootstrapInput = (overrides: Record<string, unknown> = {}) => ({
  issuer: 'https://issuer.example',
  externalSubject: 'merchant-1',
  identityId: 'identity-1',
  candidateWorkspaceId: 'ws_candidate_a',
  displayName: '第一工作区',
  actorId: 'merchant-1',
  allowCreate: true,
  ...overrides,
})

describe('MemoryWorkspaceBootstrapRepository', () => {
  it('serializes concurrent bootstrap calls and reuses the owner workspace', async () => {
    const members = new MemoryMembersRepository()
    const operations = new MemoryOperationsRepository()
    const statuses = new Map<string, 'active' | 'disabled'>()
    const repository = new MemoryWorkspaceBootstrapRepository(members, operations, workspaceId => statuses.set(workspaceId, 'active'), workspaceId => statuses.get(workspaceId) ?? 'active')

    const [first, second] = await Promise.all([
      repository.bootstrap({ issuer: 'https://issuer.example', externalSubject: 'merchant-1', identityId: 'identity-1', candidateWorkspaceId: 'ws_candidate_a', displayName: '第一工作区', actorId: 'merchant-1', allowCreate: true }),
      repository.bootstrap({ issuer: 'https://issuer.example', externalSubject: 'merchant-1', identityId: 'identity-1', candidateWorkspaceId: 'ws_candidate_b', displayName: '第二工作区', actorId: 'merchant-1', allowCreate: true }),
    ])

    expect(new Set([first.workspaceId, second.workspaceId])).toEqual(new Set(['ws_candidate_a']))
    expect([first.created, second.created].sort()).toEqual([false, true])
    expect(await members.list('ws_candidate_a')).toEqual([expect.objectContaining({ externalSubject: 'merchant-1', identityId: 'identity-1', role: 'workspace_owner', status: 'active' })])
    expect(await members.list('ws_candidate_b')).toEqual([])
    expect(await operations.list('ws_candidate_a')).toHaveLength(1)
  })

  it('isolates the same subject under different trusted issuers', async () => {
    const members = new MemoryMembersRepository()
    const operations = new MemoryOperationsRepository()
    const statuses = new Map<string, 'active' | 'disabled'>()
    const repository = new MemoryWorkspaceBootstrapRepository(members, operations, workspaceId => statuses.set(workspaceId, 'active'), workspaceId => statuses.get(workspaceId) ?? 'active')

    const left = await repository.bootstrap({ issuer: 'https://issuer-a.example', externalSubject: 'shared-subject', candidateWorkspaceId: 'ws_issuer_a', displayName: 'A', actorId: 'shared-subject', allowCreate: true })
    const right = await repository.bootstrap({ issuer: 'https://issuer-b.example', externalSubject: 'shared-subject', candidateWorkspaceId: 'ws_issuer_b', displayName: 'B', actorId: 'shared-subject', allowCreate: true })

    expect(left.workspaceId).toBe('ws_issuer_a')
    expect(right.workspaceId).toBe('ws_issuer_b')
  })

  it('resolves an existing binding without create authority and denies unassigned identities', async () => {
    const members = new MemoryMembersRepository()
    const operations = new MemoryOperationsRepository()
    const activated: string[] = []
    const repository = new MemoryWorkspaceBootstrapRepository(members, operations, workspaceId => { activated.push(workspaceId) }, () => 'active')
    await repository.bootstrap(bootstrapInput())

    await expect(repository.bootstrap(bootstrapInput({ candidateWorkspaceId: 'ws_must_not_exist', allowCreate: false })))
      .resolves.toMatchObject({ workspaceId: 'ws_candidate_a', created: false })
    await expect(repository.bootstrap(bootstrapInput({ externalSubject: 'unassigned-user', actorId: 'unassigned-user', allowCreate: false })))
      .rejects.toMatchObject({ code: 'WORKSPACE_ADMIN_ASSIGNMENT_REQUIRED' })
    expect(activated).toEqual(['ws_candidate_a'])
    expect(await members.list('ws_must_not_exist')).toEqual([])
  })
})

/**
 * `platform_identities` belongs to the isolated control-plane role: migration
 * 186 keeps `ensure-app-role.sql`'s `REVOKE ALL ... FROM merchant_app` in force,
 * so a bootstrap that reads it through the tenant pool fails the first request
 * of every new session with `permission denied for table platform_identities`.
 * The routing is asserted per pool rather than inferred, because the real-role
 * acceptance test for it lives in the isolated PostgreSQL suite.
 */
describe('PostgresWorkspaceBootstrapRepository pool routing', () => {
  it('reads the identity on the second pool and keeps every tenant statement on the first', async () => {
    const tenant = new StubPool(undefined, true)
    const control = new StubPool({ id: 'identity-1' })

    const result = await new PostgresWorkspaceBootstrapRepository(tenant, control).bootstrap(bootstrapInput())

    expect(result).toMatchObject({ workspaceId: 'ws_candidate_a', created: true })
    expect(control.calls.some(statement => statement.includes('SELECT id FROM platform_identities'))).toBe(true)
    expect(control.calls.some(statement => statement.includes('workspaces') || statement.includes('workspace_members'))).toBe(false)
    expect(tenant.calls.some(statement => statement.includes('platform_identities'))).toBe(false)
    for (const table of ['INSERT INTO workspaces', 'INSERT INTO workspace_members', 'INSERT INTO workspace_identity_bindings', 'INSERT INTO workspace_operation_audit']) {
      expect(tenant.calls.some(statement => statement.includes(table)), `${table} must run on the tenant pool`).toBe(true)
    }
  })

  it('falls back to the single pool, where the deployment role model still decides', async () => {
    const allowed = new StubPool({ id: 'identity-1' })
    await expect(new PostgresWorkspaceBootstrapRepository(allowed).bootstrap(bootstrapInput()))
      .resolves.toMatchObject({ created: true })
    expect(allowed.calls.some(statement => statement.includes('SELECT id FROM platform_identities'))).toBe(true)
    // A single pool without the platform grant fails closed, exactly as it did
    // before the second pool existed, rather than silently skipping the check.
    await expect(new PostgresWorkspaceBootstrapRepository(new StubPool(undefined, true)).bootstrap(bootstrapInput()))
      .rejects.toMatchObject({ code: '42501' })
  })

  it('refuses an identity that does not match the observed subject before touching tenant data', async () => {
    const tenant = new StubPool(undefined, true)
    const control = new StubPool()
    await expect(new PostgresWorkspaceBootstrapRepository(tenant, control).bootstrap(bootstrapInput()))
      .rejects.toBeInstanceOf(WorkspaceBootstrapError)
    expect(control.calls.some(statement => statement.includes('SELECT id FROM platform_identities'))).toBe(true)
    expect(tenant.calls).toEqual([])
  })

  it('does not read the platform table when no identity was observed', async () => {
    const tenant = new StubPool(undefined, true)
    const control = new StubPool({ id: 'identity-1' })
    await expect(new PostgresWorkspaceBootstrapRepository(tenant, control).bootstrap(bootstrapInput({ identityId: undefined })))
      .resolves.toMatchObject({ created: true })
    expect(control.calls).toEqual([])
    expect(tenant.calls.some(statement => statement.includes('platform_identities'))).toBe(false)
  })

  it('refuses unassigned identities without inserting tenant, member, binding, or audit rows', async () => {
    const tenant = new StubPool()
    const control = new StubPool({ id: 'identity-1' })
    await expect(new PostgresWorkspaceBootstrapRepository(tenant, control).bootstrap(bootstrapInput({ allowCreate: false })))
      .rejects.toMatchObject({ code: 'WORKSPACE_ADMIN_ASSIGNMENT_REQUIRED' })
    expect(tenant.calls.some(statement => /INSERT INTO (workspaces|workspace_members|workspace_identity_bindings|workspace_operation_audit)/u.test(statement))).toBe(false)
  })
})
