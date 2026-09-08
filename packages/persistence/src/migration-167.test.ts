import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('167 private trial conversion closure migration', () => {
  it('registers the audited 1999 -> 3001 conversion facts without modifying catalog policy', async () => {
    const sql = await readFile(new URL('./migrations/167_private_trial_conversion_closure.sql', import.meta.url), 'utf8')
    await expect(loadMigrations()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ version: 167, name: 'private_trial_conversion_closure' })]))
    expect(sql).toContain('offset_fen = 199900')
    expect(sql).toContain('payable_fen = 300100')
    expect(sql).toContain('payment_subject_ref')
    expect(sql).toContain('private_trial_eligibility_events_v2')
    expect(sql).toContain('private_trial_credit_events_v2')
    expect(sql).not.toContain('commercial_catalog_sku_versions')
  })

  it('keeps repository credit events within the database enum', async () => {
    const migration = await readFile(new URL('./migrations/167_private_trial_conversion_closure.sql', import.meta.url), 'utf8')
    const repository = await readFile(new URL('./private-trial-conversion-repository.ts', import.meta.url), 'utf8')
    expect(migration).toContain("event_type IN ('prepared', 'accounting_approved', 'order_created', 'applied', 'expired', 'rejected')")
    expect(repository).not.toContain("creditEvent(client, workspaceId, input.creditId, 'payment_verified'")
    expect(repository).toContain("creditEvent(client, workspaceId, input.creditId, 'applied'")
  })
})
