import { describe, expect, it, vi } from 'vitest'
import { FirstWorkspaceProvisionError, PostgresFirstWorkspaceProvisioningRepository } from './first-workspace-provisioning-repository.js'
import type { SqlPool } from './repository.js'

const input = {
  platformActorIdentityId: '11111111-1111-4111-8111-111111111111',
  workspaceId: 'ws_guirenniaoniao',
  ownerIdentityId: '22222222-2222-4222-8222-222222222222',
  ownerIssuer: 'urn:store-nova:local',
  ownerSubject: 'merchant@example.com',
  ownerDisplayName: 'Merchant',
  reason: '管理员核验商家身份后建立首工作区',
}

function harness(options: { existing?: Record<string, string>; actor?: boolean; occupied?: boolean } = {}) {
  const statements: string[] = []
  const query = vi.fn(async (sql: string) => {
    statements.push(sql)
    if (sql.includes('JOIN platform_role_assignments')) return { rows: options.actor === false ? [] : [{ id: input.platformActorIdentityId }] }
    if (sql.includes('FROM platform_identities WHERE id=')) return { rows: [{ id: input.ownerIdentityId }] }
    if (sql.includes('FROM workspace_identity_bindings binding')) return { rows: options.existing ? [options.existing] : [] }
    if (sql.includes('SELECT id FROM workspaces')) return { rows: options.occupied ? [{ id: input.workspaceId }] : [] }
    return { rows: [] }
  })
  const release = vi.fn()
  const repository = new PostgresFirstWorkspaceProvisioningRepository({ connect: async () => ({ query, release }) } as SqlPool)
  return { repository, statements, release }
}

describe('first workspace provisioning', () => {
  it('creates member, binding and audit in one committed transaction', async () => {
    const { repository, statements, release } = harness()
    await expect(repository.provision(input)).resolves.toEqual({ workspaceId: input.workspaceId, created: true })
    expect(statements[0]).toBe('BEGIN')
    expect(statements.filter(sql => sql.startsWith('INSERT INTO'))).toHaveLength(4)
    expect(statements.at(-1)).toBe('COMMIT')
    expect(release).toHaveBeenCalledOnce()
  })

  it('replays only an identical active owner binding without a second write', async () => {
    const { repository, statements } = harness({ existing: { workspace_id: input.workspaceId, identity_id: input.ownerIdentityId, status: 'active', role: 'workspace_owner', workspace_status: 'active' } })
    await expect(repository.provision(input)).resolves.toEqual({ workspaceId: input.workspaceId, created: false })
    expect(statements.some(sql => sql.startsWith('INSERT INTO'))).toBe(false)
  })

  it('rejects missing platform privilege and rolls back', async () => {
    const { repository, statements } = harness({ actor: false })
    await expect(repository.provision(input)).rejects.toMatchObject({ code: 'PLATFORM_ACTOR_FORBIDDEN' } satisfies Partial<FirstWorkspaceProvisionError>)
    expect(statements.at(-1)).toBe('ROLLBACK')
  })

  it('rejects an occupied workspace without writing', async () => {
    const { repository, statements } = harness({ occupied: true })
    await expect(repository.provision(input)).rejects.toMatchObject({ code: 'WORKSPACE_PROVISION_CONFLICT' })
    expect(statements.some(sql => sql.startsWith('INSERT INTO'))).toBe(false)
  })
})
