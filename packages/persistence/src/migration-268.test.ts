import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('demo evaluation regrant guard migration 268', () => {
  it('is the final migration and permits only privileged expiry revocation', async () => {
    const sql = await readFile(new URL('./migrations/268_demo_evaluation_regrant_guard.sql', import.meta.url), 'utf8')
    const migrations = await loadMigrations()
    expect(migrations.find(row => row.version === 268)).toEqual({ version: 268, name: 'demo_evaluation_regrant_guard', sql })
    expect(sql).toContain("app.demo_evaluation_admin")
    expect(sql).toContain("current_user NOT IN ('merchant_app', 'merchant_ops', 'merchant_alert_receiver')")
    expect(sql).toContain("OLD.status = 'active'")
    expect(sql).toContain("NEW.status = 'revoked'")
  })
})
