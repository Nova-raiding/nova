import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import ts from 'typescript'
import { loadMigrations, MigrationRunner } from './migration.js'

const postgresIt = process.env.WORKSPACE_CATALOG_DATABASE_URL ? it : it.skip

async function loadSourceRepository() {
  const source = await readFile(new URL('./repository.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`) as Promise<typeof import('./repository.js')>
}

describe('051 active workspace catalog', () => {
  it('defines a fixed, fail-closed SECURITY DEFINER boundary with no PUBLIC access', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 51)
    expect(migration).toMatchObject({ name: 'active_workspace_catalog' })
    const sql = migration?.sql ?? ''
    expect(sql).toContain('SECURITY DEFINER')
    expect(sql).toContain('SET search_path = pg_catalog')
    expect(sql).toContain('SET row_security = off')
    expect(sql).toContain('FROM public.workspaces')
    expect(sql).toContain("WHERE workspace.status = 'active'")
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.worker_active_workspace_catalog() FROM PUBLIC')
    expect(sql).not.toMatch(/INSERT|UPDATE|DELETE|TRUNCATE|DROP TABLE/i)
  })

  it('grants only the catalog function to the local runtime role', async () => {
    const sql = await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8')
    expect(sql).toContain('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM merchant_app')
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.worker_active_workspace_catalog() TO merchant_app')
    expect(sql).not.toContain('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO merchant_app')
    expect(sql).not.toContain('GRANT EXECUTE ON FUNCTIONS TO merchant_app')
  })

  postgresIt('keeps direct RLS reads empty while the repository returns only active workspace IDs', async () => {
    const admin = new Pool({ connectionString: process.env.WORKSPACE_CATALOG_DATABASE_URL })
    let runtime: Pool | undefined
    let untrusted: Pool | undefined
    const untrustedRole = `workspace_catalog_untrusted_${randomUUID().replaceAll('-', '')}`
    try {
      const migrations = (await loadMigrations()).filter(item => item.version <= 51)
      expect(await new MigrationRunner(admin, migrations).run())
        .toEqual(Array.from({ length: 51 }, (_, index) => index + 1))
      await admin.query(`INSERT INTO workspaces (id, status) VALUES
        ('ws_active_b', 'active'), ('ws_disabled', 'disabled'), ('ws_active_a', 'active')`)
      await admin.query(await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8'))
      await admin.query(`CREATE ROLE ${untrustedRole} LOGIN PASSWORD 'untrusted_local_only'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`)
      await admin.query(`GRANT CONNECT ON DATABASE merchant TO ${untrustedRole}`)
      await admin.query(`GRANT USAGE ON SCHEMA public TO ${untrustedRole}`)

      const baseUrl = new URL(process.env.WORKSPACE_CATALOG_DATABASE_URL!)
      baseUrl.username = 'merchant_app'
      baseUrl.password = 'merchant_app_local_only'
      runtime = new Pool({ connectionString: baseUrl.toString() })

      const direct = await runtime.query<{ id: string }>('SELECT id FROM public.workspaces ORDER BY id')
      expect(direct.rows).toEqual([])
      const { PostgresOutboxRepository } = await loadSourceRepository()
      await expect(new PostgresOutboxRepository(runtime).listActiveWorkspaceIds())
        .resolves.toEqual(['ws_active_a', 'ws_active_b'])

      baseUrl.username = untrustedRole
      baseUrl.password = 'untrusted_local_only'
      untrusted = new Pool({ connectionString: baseUrl.toString() })
      await expect(untrusted.query('SELECT * FROM public.worker_active_workspace_catalog()'))
        .rejects.toMatchObject({ code: '42501' })
    } finally {
      await untrusted?.end()
      await runtime?.end()
      await admin.end()
    }
  }, 60_000)
})
