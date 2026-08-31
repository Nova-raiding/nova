import { Pool } from 'pg'
import { loadMigrations, runMigrations, type SqlPool } from '../../../packages/persistence/src/index.js'

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) throw new Error('DATABASE_URL is required for the schema migration Job')
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS ?? 10_000) })
  try {
    const applied = await runMigrations(pool as unknown as SqlPool, await loadMigrations())
    console.log(`schema migration complete: applied=${applied.length}`)
  } finally {
    await pool.end()
  }
}

main().catch(error => {
  console.error('schema migration failed', error instanceof Error ? error.message : 'unknown error')
  process.exitCode = 1
})
