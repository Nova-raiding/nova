import { describe, expect, it } from 'vitest'
import { assertOwnedPostgresTestBinding } from './fixtures/owned-postgres-binding.js'

describe('owned PostgreSQL test binding', () => {
  const runId = '3b12f1df-5232-4804-897e-917bf397618a'

  it('accepts only the isolated runner-shaped loopback admin binding', () => {
    expect(assertOwnedPostgresTestBinding('postgres://merchant:secret@127.0.0.1:55432/merchant', runId).port).toBe('55432')
  })

  it.each([
    [undefined, runId],
    ['postgres://merchant:secret@db.internal:5432/merchant', runId],
    ['postgres://merchant:secret@127.0.0.1:5432/production', runId],
    ['postgres://merchant:secret@127.0.0.1:5432/merchant?sslmode=require', runId],
    ['postgres://merchant:secret@127.0.0.1:5432/merchant', undefined],
  ])('rejects a missing, shared, production, or unowned binding', (url, id) => {
    expect(() => assertOwnedPostgresTestBinding(url, id)).toThrow('ISOLATED_POSTGRES_FIXTURE_BINDING_REQUIRED')
  })
})
