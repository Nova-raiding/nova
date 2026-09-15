import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { Pool } from 'pg'

const exec = promisify(execFile)

/**
 * Schema restore acceptance must use client binaries from the same major
 * release as the server. PostgreSQL only guarantees dump/restore compatibility
 * in the supported direction; silently using an older PATH binary makes a
 * release test a false positive/negative. Fail closed with an actionable error.
 */
export async function assertPostgresReleaseTooling(pool: Pool): Promise<{ pgDump: string; pgRestore: string; major: number }> {
  const dump = process.env.PG_DUMP_BIN ?? 'pg_dump'
  const restore = process.env.PG_RESTORE_BIN ?? (dump.includes('/') ? join(dirname(dump), 'pg_restore') : 'pg_restore')
  const [{ stdout: dumpVersion }, { stdout: restoreVersion }, server] = await Promise.all([
    exec(dump, ['--version']),
    exec(restore, ['--version']),
    pool.query<{ server_version: string }>('SHOW server_version'),
  ])
  const clientMajor = Number.parseInt(/PostgreSQL\)\s+(\d+)/u.exec(dumpVersion)?.[1] ?? '', 10)
  const restoreMajor = Number.parseInt(/PostgreSQL\)\s+(\d+)/u.exec(restoreVersion)?.[1] ?? '', 10)
  const serverMajor = Number.parseInt(server.rows[0]?.server_version.split('.')[0] ?? '', 10)
  if (![clientMajor, restoreMajor, serverMajor].every(Number.isInteger) || clientMajor !== restoreMajor || clientMajor !== serverMajor) {
    throw new Error(`PostgreSQL release tooling mismatch: server=${server.rows[0]?.server_version ?? 'unknown'}, pg_dump=${dumpVersion.trim()}, pg_restore=${restoreVersion.trim()}. Set PG_DUMP_BIN and PG_RESTORE_BIN to matching binaries.`)
  }
  return { pgDump: dump, pgRestore: restore, major: serverMajor }
}
