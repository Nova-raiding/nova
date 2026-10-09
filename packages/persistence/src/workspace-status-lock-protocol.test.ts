import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acquireWorkspaceStatusLocks, type SqlClient } from './repository.js'

const root = resolve(import.meta.dirname, '../../..')

describe('workspace status transaction lock protocol', () => {
  it('uses one transaction advisory lock per unique workspace in stable order', async () => {
    const queries: Array<{ sql: string; values?: readonly unknown[] }> = []
    const client: SqlClient = {
      async query(sql, values) { queries.push({ sql, values }); return { rows: [] } },
    }

    await acquireWorkspaceStatusLocks(client, ['ws-z', 'ws-a', 'ws-z', '  '])

    expect(queries).toEqual([
      {
        sql: "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('merchant_workspace_status_v1'), pg_catalog.hashtext($1))",
        values: ['ws-a'],
      },
      {
        sql: "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('merchant_workspace_status_v1'), pg_catalog.hashtext($1))",
        values: ['ws-z'],
      },
    ])
  })

  it('approval and deactivation take the shared lock before workspace status reads or writes', () => {
    const repository = readFileSync(resolve(root, 'packages/persistence/src/password-auth-repository.ts'), 'utf8')
    const postgresStart = repository.indexOf('export class PostgresPasswordAuthRepository')
    const approvalStart = repository.indexOf('async reviewMerchantRegistration', postgresStart)
    const approvalEnd = repository.indexOf('async ensurePlatformAccount', approvalStart)
    const approval = repository.slice(approvalStart, approvalEnd)
    const server = readFileSync(resolve(root, 'apps/api/src/server.ts'), 'utf8')
    const deactivateStart = server.indexOf('const setWorkspaceStatus = async')
    const deactivateEnd = server.indexOf('const commercialRuntimeSchemaDigest', deactivateStart)
    const deactivation = server.slice(deactivateStart, deactivateEnd)

    expect(approval).toContain('await acquireWorkspaceStatusLocks(client, workspaceIds)')
    expect(approval.indexOf('await acquireWorkspaceStatusLocks')).toBeLessThan(approval.indexOf('SELECT id FROM workspaces'))
    expect(approval.indexOf('SELECT id FROM workspaces')).toBeLessThan(approval.indexOf('UPDATE platform_password_accounts'))
    expect(deactivation).toContain('await acquireWorkspaceStatusLocks(client, [workspaceId])')
    expect(deactivation.indexOf('await acquireWorkspaceStatusLocks')).toBeLessThan(deactivation.indexOf('INSERT INTO workspaces'))
    expect(deactivation.indexOf('INSERT INTO workspaces')).toBeLessThan(deactivation.indexOf('UPDATE workspaces SET status'))
  })
})
