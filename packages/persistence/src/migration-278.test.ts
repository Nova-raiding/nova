import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('task feedback idempotency migration 278', () => {
  it('registers the forward migration and rejects one-sided NULL hash pairs', async () => {
    const migrations = await loadMigrations()
    const sql = await readFile(new URL('./migrations/278_task_feedback_idempotency.sql', import.meta.url), 'utf8')
    expect(migrations.find(row => row.version === 278)).toEqual({ version: 278, name: 'task_feedback_idempotency', sql })
    expect(sql).toMatch(/CHECK\s*\(\(idempotency_key_hash\s+IS NULL\s+AND\s+request_hash\s+IS NULL\)\s+OR\s+\(idempotency_key_hash\s+IS NOT NULL\s+AND\s+request_hash\s+IS NOT NULL\s+AND\s+idempotency_key_hash\s*~/iu)
    expect(sql).toMatch(/AND\s+request_hash\s*~\s*'\^\[0-9a-f\]\{64\}\$'/iu)
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS task_feedback_workspace_idempotency_key_idx')
  })
})
