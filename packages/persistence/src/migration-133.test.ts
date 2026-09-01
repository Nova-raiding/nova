import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('migration 133 parallel merge barrier', () => {
  it('preserves the immutable migration slot without changing business data', async () => {
    const sql = await readFile(new URL('./migrations/133_parallel_migration_merge_barrier.sql', import.meta.url), 'utf8')
    expect(sql).toContain('Immutable merge barrier')
    expect(sql).toContain('PERFORM 1')
    expect(sql).not.toMatch(/\b(?:DELETE|DROP|TRUNCATE|UPDATE)\b/iu)
  })
})
