import { describe, expect, it } from 'vitest'
import { PostgresScopedBrandSettingsRepository } from './scoped-brand-settings-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

describe('scoped brand settings repository input guards', () => {
  it('rejects blank, control-character and oversized actors before opening a database connection', async () => {
    let connections = 0
    const pool: SqlPool = { connect: async () => { connections += 1; throw new Error('unexpected database connection') } }
    const repository = new PostgresScopedBrandSettingsRepository(pool)
    const save = (actorId: string) => repository.save({
      workspaceId: 'workspace-a', settings: { schemaVersion: 1 }, expectedRevision: 0,
      actorId, validate: value => value as Record<string, unknown>,
    })

    for (const actorId of ['', '  ', 'operator\u0000admin', 'x'.repeat(256)]) {
      await expect(save(actorId)).rejects.toMatchObject({ code: 'BRAND_SCOPE_ACTOR_INVALID' })
    }
    expect(connections).toBe(0)
  })

  it('rejects invalid setting revisions before opening a database connection', async () => {
    let connections = 0
    const pool: SqlPool = { connect: async () => { connections += 1; throw new Error('unexpected database connection') } }
    const repository = new PostgresScopedBrandSettingsRepository(pool)

    for (const expectedRevision of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(repository.save({
        workspaceId: 'workspace-a', settings: { schemaVersion: 1 }, expectedRevision,
        actorId: 'operator-a', validate: value => value as Record<string, unknown>,
      })).rejects.toMatchObject({ code: 'BRAND_SCOPE_REVISION_INVALID' })
    }
    expect(connections).toBe(0)
  })

  it('rejects invalid assignment revisions before opening a database connection', async () => {
    let connections = 0
    const pool: SqlPool = { connect: async () => { connections += 1; throw new Error('unexpected database connection') } }
    const repository = new PostgresScopedBrandSettingsRepository(pool)

    await expect(repository.assignAsset({
      workspaceId: 'workspace-a', assetId: 'asset-a', accountId: 'store-a', expectedRevision: -1,
    })).rejects.toMatchObject({ code: 'BRAND_SCOPE_REVISION_INVALID' })
    expect(connections).toBe(0)
  })

  it('rejects invalid series names before opening a database connection', async () => {
    let connections = 0
    const pool: SqlPool = { connect: async () => { connections += 1; throw new Error('unexpected database connection') } }
    const repository = new PostgresScopedBrandSettingsRepository(pool)

    for (const name of ['', '   ', 'x'.repeat(161)]) {
      await expect(repository.createSeries({ workspaceId: 'workspace-a', accountId: 'store-a', name }))
        .rejects.toMatchObject({ code: 'BRAND_SERIES_NAME_INVALID' })
    }
    expect(connections).toBe(0)
  })

  it('rejects over-limit binding references before querying tenant data', async () => {
    const statements: string[] = []
    const client: SqlClient = {
      async query<T = Record<string, unknown>>(sql: string) {
        statements.push(sql)
        return { rows: [] as T[] }
      },
      release() {},
    }
    const repository = new PostgresScopedBrandSettingsRepository({ connect: async () => client })
    const stores = Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`store-${index}`, { enabled: true, values: {} }]))

    await expect(repository.save({
      workspaceId: 'workspace-a', settings: { schemaVersion: 1, stores }, expectedRevision: 0,
      actorId: 'operator-a', validate: value => value as Record<string, unknown>,
    })).rejects.toMatchObject({ code: 'BRAND_SCOPE_LIMIT' })
    expect(statements.some(sql => sql.includes('FROM platform_accounts'))).toBe(false)
    expect(statements).toContain('ROLLBACK')
  })
})
