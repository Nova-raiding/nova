import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from '../../../packages/persistence/src/migration.js'
import { assertWorkerReadinessDependencies } from './main.js'

describe('worker schema bridge readiness', () => {
  it('accepts only complete, checksummed prefixes approved by each bridge mode', async () => {
    const migrations = await loadMigrations()
    expect(migrations).toHaveLength(256)
    const rows = migrations.map(migration => ({
      version: migration.version,
      name: migration.name,
      checksum: createHash('sha256').update(migration.sql).digest('hex'),
    }))
    const ready = (history: typeof rows, mode = 'prefix_254_or_255') =>
      assertWorkerReadinessDependencies({
        database: { query: async () => ({ rows: history }) },
        expectedMigrations: migrations,
        bridgeMigrations: migrations,
        bridgeMode: mode,
      })

    await expect(ready(rows.slice(0, 254))).resolves.toEqual({ migrationVersion: 254, apiReady: false })
    await expect(ready(rows.slice(0, 255))).resolves.toEqual({ migrationVersion: 255, apiReady: false })
    await expect(ready(rows.slice(0, 253))).rejects.toThrow('exactly 254 or 255')
    await expect(ready(rows.slice(0, 254).filter(row => row.version !== 42))).rejects.toThrow()
    await expect(ready([{ ...rows[0]!, checksum: '0'.repeat(64) }, ...rows.slice(1, 254)])).rejects.toThrow('checksum mismatch')
    await expect(ready([{ ...rows[0]!, name: 'foreign' }, ...rows.slice(1, 254)])).rejects.toThrow('name mismatch')
    await expect(ready(rows.slice(0, 254), 'prefix_242_or_254')).resolves.toEqual({ migrationVersion: 254, apiReady: false })
    await expect(ready(rows.slice(0, 254), 'unknown')).rejects.toThrow('not enabled')
    await expect(ready(rows.slice(0, 255), 'prefix_255_or_256')).resolves.toEqual({ migrationVersion: 255, apiReady: false })
    await expect(ready(rows, 'prefix_255_or_256')).resolves.toEqual({ migrationVersion: 256, apiReady: false })
    await expect(ready(rows.slice(0, 254), 'prefix_255_or_256')).rejects.toThrow('exactly 255 or 256')
    await expect(assertWorkerReadinessDependencies({
      database: { query: async () => ({ rows: rows.slice(0, 254) }) }, expectedMigrations: migrations,
    })).rejects.toThrow('expected complete migration chain through 256')
  })
})
