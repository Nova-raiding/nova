import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner, migrationChecksum, verifyAppliedMigrations } from '../packages/persistence/src/migration.js'
import { PG16_MIGRATION_CONTAINER_IMAGE, PG16_MIGRATION_PURPOSE, PG16_MIGRATION_LABEL_PREFIX, verifyPg16MigrationContainer, type Pg16MigrationContainerIdentity } from './ecs-pg16-migration-container-safety.js'

const DATA_PATH = '/var/lib/postgresql/data'
const SECRET_KEYS = ['POSTGRES_USER', 'POSTGRES_DB', 'POSTGRES_PASSWORD'] as const

function localDockerSocketCandidates(): string[] {
  return [
    '/var/run/docker.sock',
    join(process.env.HOME ?? '/nonexistent', '.docker/run/docker.sock'),
    join(process.env.HOME ?? '/nonexistent', '.colima/default/docker.sock'),
    join(process.env.HOME ?? '/nonexistent', '.orbstack/run/docker.sock'),
  ]
}

async function findLocalDockerSocket(): Promise<string> {
  const sockets: string[] = []
  for (const candidate of localDockerSocketCandidates()) {
    try {
      if ((await stat(candidate)).isSocket()) sockets.push(candidate)
    } catch { /* this local daemon socket is absent */ }
  }
  if (sockets.length !== 1) throw new Error('PG16_ISOLATED_LOCAL_DOCKER_SOCKET_AMBIGUOUS_OR_MISSING')
  return sockets[0]!
}

function runDocker(socket: string, configDir: string, args: readonly string[], env: NodeJS.ProcessEnv): string {
  try {
    return execFileSync('docker', ['--host', `unix://${socket}`, '--config', configDir, ...args], {
      env,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch {
    // docker's error text can include command arguments or daemon diagnostics;
    // do not leak any generated credential through a Vitest failure message.
    throw new Error(`PG16_ISOLATED_DOCKER_${args[0]?.toUpperCase() ?? 'COMMAND'}_FAILED`)
  }
}

describe('PostgreSQL 16 isolated execution of migrations 1..257', () => {
  it('runs the full migration chain on a private tmpfs container and verifies exact history', async () => {
    const runId = randomUUID()
    const name = `merchant-pg16-migration-${runId}`
    const username = `pg16_${randomBytes(8).toString('hex')}`
    const databaseName = `migration_${randomBytes(8).toString('hex')}`
    const password = randomBytes(32).toString('hex')
    const socket = await findLocalDockerSocket()
    const configDir = await mkdtemp(join(tmpdir(), 'pg16-migration-docker-config-'))
    const dockerEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
    }
    const dockerSecrets = { POSTGRES_USER: username, POSTGRES_DB: databaseName, POSTGRES_PASSWORD: password }
    for (const key of SECRET_KEYS) dockerEnv[key] = dockerSecrets[key]

    let containerId: string | undefined
    let pool: Pool | undefined
    let failure: unknown
    let cleanupFailure: unknown
    try {
      const imageId = runDocker(socket, configDir, ['image', 'inspect', PG16_MIGRATION_CONTAINER_IMAGE, '--format', '{{.Id}}'], dockerEnv)
      if (!/^sha256:[a-f0-9]{64}$/u.test(imageId)) throw new Error('PG16_ISOLATED_IMAGE_ID_INVALID')

      containerId = runDocker(socket, configDir, [
        'run', '--detach', '--rm', '--pull=never', '--name', name,
        '--label', `${PG16_MIGRATION_LABEL_PREFIX}.purpose=${PG16_MIGRATION_PURPOSE}`,
        '--label', `${PG16_MIGRATION_LABEL_PREFIX}.run-id=${runId}`,
        '--publish', '127.0.0.1::5432',
        '--tmpfs', `${DATA_PATH}:rw,noexec,nosuid,size=512m`,
        '--security-opt', 'no-new-privileges:true',
        '--pids-limit', '128',
        ...SECRET_KEYS.flatMap(key => ['--env', key]),
        PG16_MIGRATION_CONTAINER_IMAGE,
      ], dockerEnv)
      if (!/^[a-f0-9]{64}$/u.test(containerId)) throw new Error('PG16_ISOLATED_CONTAINER_ID_INVALID')

      const inspect = (): Pg16MigrationContainerIdentity => JSON.parse(runDocker(socket, configDir, [
        'inspect', '--format',
        '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"imageId":{{json .Image}},"labels":{{json .Config.Labels}},"autoRemove":{{json .HostConfig.AutoRemove}},"running":{{json .State.Running}},"tmpfs":{{json .HostConfig.Tmpfs}},"mounts":{{json .Mounts}},"ports":{{json .NetworkSettings.Ports}}}',
        containerId!,
      ], dockerEnv)) as Pg16MigrationContainerIdentity

      const first = inspect()
      verifyPg16MigrationContainer(first, { id: containerId, name, runId, imageId, running: true })
      const hostPort = Number(first.ports['5432/tcp']?.[0]?.HostPort)
      const migrations = await loadMigrations()
      expect(migrations.slice(0, 257)).toHaveLength(257)
      expect(migrations.slice(0, 257).map(migration => migration.version)).toEqual(Array.from({ length: 257 }, (_, index) => index + 1))

      pool = new Pool({
        host: '127.0.0.1', port: hostPort, database: databaseName, user: username,
        password, max: 4, connectionTimeoutMillis: 2_000,
      })
      const deadline = Date.now() + 60_000
      let connected = false
      while (Date.now() < deadline) {
        try {
          const version = await pool.query<{ server_version_num: string }>("SELECT current_setting('server_version_num') AS server_version_num")
          const serverVersion = Number(version.rows[0]?.server_version_num)
          if (serverVersion < 160000 || serverVersion >= 170000) throw new Error('PG16_ISOLATED_SERVER_VERSION_MISMATCH')
          connected = true
          break
        } catch (error) {
          if (error instanceof Error && error.message === 'PG16_ISOLATED_SERVER_VERSION_MISMATCH') throw error
          await new Promise(resolve => setTimeout(resolve, 500))
        }
      }
      if (!connected) throw new Error('PG16_ISOLATED_POSTGRES_STARTUP_TIMEOUT')

      await pool.query(`CREATE ROLE merchant_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`)
      await pool.query(`CREATE ROLE merchant_ops LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`)
      await pool.query(`CREATE ROLE merchant_alert_receiver LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`)
      // Historical migrations alter defaults for the legacy owner role even
      // though application connections use merchant_app/merchant_ops.
      await pool.query(`CREATE ROLE merchant NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`)
      await pool.query(`GRANT CONNECT ON DATABASE "${databaseName}" TO merchant_app, merchant_ops, merchant_alert_receiver`)
      await pool.query('GRANT USAGE ON SCHEMA public TO merchant_app, merchant_ops, merchant_alert_receiver')
      // Model the established runtime bootstrap contract before the chain is
      // applied; later migrations must preserve read-only migration history.
      await pool.query(`CREATE TABLE public.schema_migrations (
        version integer PRIMARY KEY, name text NOT NULL, checksum text,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`)
      await pool.query('GRANT SELECT ON public.schema_migrations TO merchant_app, merchant_ops')
      await new MigrationRunner(pool, migrations.slice(0, 257)).run()

      const expectedRows = migrations.slice(0, 257).map(migration => ({
        version: migration.version,
        name: migration.name,
        checksum: migrationChecksum(migration.sql),
      }))
      const historyResult = await pool.query<{ version: number; name: string; checksum: string }>(
        'SELECT version, name, checksum FROM public.schema_migrations ORDER BY version',
      )
      expect(historyResult.rows).toEqual(expectedRows)
      expect(() => verifyAppliedMigrations(historyResult.rows, migrations)).not.toThrow()
      expect(historyResult.rows).toHaveLength(257)
      for (const [version, name] of [[254, 'merchant_entitlement_snapshot_cursor'], [255, 'scoped_brand_settings'], [256, 'asset_lifecycle'], [257, 'asset_snapshot_lifecycle_guard']] as const) {
        const actual = historyResult.rows[version - 1]
        const migration = migrations[version - 1]
        expect(actual).toEqual({ version, name, checksum: migrationChecksum(migration!.sql) })
      }

      const brandTables = await pool.query<{ table_name: string; row_security: boolean; force_row_security: boolean }>(
        `SELECT c.relname AS table_name, c.relrowsecurity AS row_security, c.relforcerowsecurity AS force_row_security
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
         ORDER BY c.relname`,
        [['merchant_brand_series', 'merchant_brand_asset_assignments', 'merchant_brand_scoped_settings']],
      )
      expect(brandTables.rows).toHaveLength(3)
      expect(brandTables.rows.every(row => row.row_security && row.force_row_security)).toBe(true)
      const lifecycleColumns = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema='public' AND table_name='merchant_asset_lifecycle'`,
      )
      expect(lifecycleColumns.rows.map(row => row.column_name)).toEqual(expect.arrayContaining([
        'workspace_id', 'asset_id', 'deleted_at', 'expires_at', 'purge_requested_at',
        'restored_at', 'purged_at', 'purge_lease_token', 'purge_lease_until', 'purge_attempts', 'revision',
      ]))
      const lifecycleGuards = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname = ANY($1::text[])`,
        [['merchant_asset_lifecycle_trash_idx', 'merchant_asset_lifecycle_expiry_idx']],
      )
      expect(lifecycleGuards.rows.map(row => row.indexname).sort()).toEqual([
        'merchant_asset_lifecycle_expiry_idx', 'merchant_asset_lifecycle_trash_idx',
      ])
      const lifecycleTriggers = await pool.query<{ trigger_name: string }>(
        `SELECT trigger_name FROM information_schema.triggers
         WHERE trigger_schema='public' AND event_object_table IN ('merchant_asset_lifecycle','merchant_asset_lifecycle_events','business_entity_snapshots')
           AND trigger_name IN ('merchant_asset_lifecycle_asset_snapshot_guard','merchant_asset_lifecycle_snapshot_delete_guard','merchant_asset_lifecycle_events_append_only')`,
      )
      expect(new Set(lifecycleTriggers.rows.map(row => row.trigger_name))).toEqual(new Set([
        'merchant_asset_lifecycle_asset_snapshot_guard',
        'merchant_asset_lifecycle_snapshot_delete_guard',
        'merchant_asset_lifecycle_events_append_only',
      ]))
      const lifecycleSnapshotFk = await pool.query<{ constraint_name: string; definition: string }>(
        `SELECT con.conname AS constraint_name, pg_get_constraintdef(con.oid) AS definition
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace ns ON ns.oid = rel.relnamespace
         WHERE ns.nspname = 'public' AND rel.relname = 'merchant_asset_lifecycle'
           AND con.conname = 'merchant_asset_lifecycle_asset_snapshot_fk' AND con.contype = 'f'`,
      )
      expect(lifecycleSnapshotFk.rows).toHaveLength(1)
      expect(lifecycleSnapshotFk.rows[0]?.definition).toContain('FOREIGN KEY (workspace_id, snapshot_entity_type, asset_id)')
      expect(lifecycleSnapshotFk.rows[0]?.definition).toContain('REFERENCES business_entity_snapshots(workspace_id, entity_type, entity_id) ON DELETE RESTRICT')
      const snapshotEntityTypeCheck = await pool.query<{ constraint_name: string; definition: string }>(
        `SELECT con.conname AS constraint_name, pg_get_constraintdef(con.oid) AS definition
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace ns ON ns.oid = rel.relnamespace
         WHERE ns.nspname = 'public' AND rel.relname = 'merchant_asset_lifecycle'
           AND con.conname = 'merchant_asset_lifecycle_snapshot_entity_type_check' AND con.contype = 'c'`,
      )
      expect(snapshotEntityTypeCheck.rows).toHaveLength(1)
      expect(snapshotEntityTypeCheck.rows[0]?.definition).toMatch(/snapshot_entity_type = 'asset'/u)

      for (const role of ['merchant_app', 'merchant_ops'] as const) {
        const client = await pool.connect()
        try {
          await client.query(`SET ROLE ${role}`)
          const roleHistory = await client.query<{ version: number; name: string; checksum: string }>(
            'SELECT version, name, checksum FROM public.schema_migrations ORDER BY version',
          )
          expect(roleHistory.rows, `${role} migration history`).toEqual(expectedRows)
        } finally {
          try { await client.query('RESET ROLE') } finally { client.release() }
        }
      }
      verifyPg16MigrationContainer(inspect(), { id: containerId, name, runId, imageId, running: true })
    } catch (error) {
      failure = error
    } finally {
      if (pool) {
        try { await pool.end() } catch (error) { cleanupFailure = error }
      }
      if (containerId) {
        try {
          const observed = JSON.parse(runDocker(socket, configDir, [
            'inspect', '--format',
            '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"imageId":{{json .Image}},"labels":{{json .Config.Labels}},"autoRemove":{{json .HostConfig.AutoRemove}},"running":{{json .State.Running}},"tmpfs":{{json .HostConfig.Tmpfs}},"mounts":{{json .Mounts}},"ports":{{json .NetworkSettings.Ports}}}',
            containerId,
          ], dockerEnv)) as Pg16MigrationContainerIdentity
          verifyPg16MigrationContainer(observed, {
            id: containerId, name, runId, running: observed.running,
          })
          if (observed.running) runDocker(socket, configDir, ['stop', '--time', '10', containerId], dockerEnv)
          const removalDeadline = Date.now() + 5_000
          let remaining = containerId
          while (Date.now() < removalDeadline && remaining !== '') {
            remaining = runDocker(socket, configDir, [
              'container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', `id=${containerId}`,
            ], dockerEnv)
            if (remaining !== '') await new Promise(resolve => setTimeout(resolve, 100))
          }
          if (remaining !== '') throw new Error('PG16_ISOLATED_CONTAINER_STILL_EXISTS_AFTER_STOP')
        } catch (error) {
          cleanupFailure = cleanupFailure ? new AggregateError([cleanupFailure, error], 'PG16 isolated cleanup failed') : error
        }
      }
      try { await rm(configDir, { recursive: true }) } catch (error) {
        cleanupFailure = cleanupFailure ? new AggregateError([cleanupFailure, error], 'PG16 isolated cleanup failed') : error
      }
    }
    if (failure && cleanupFailure) throw new AggregateError([failure, cleanupFailure], 'PG16 isolated migration test and cleanup both failed')
    if (cleanupFailure) throw new Error(`PG16_ISOLATED_CLEANUP_FAILED: ${cleanupFailure instanceof Error ? cleanupFailure.message : 'unknown error'}`)
    if (failure) throw failure
  }, 180_000)
})
