import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(new URL('./migrations/148_harden_creative_point_reservations.sql', import.meta.url), 'utf8')

describe('migration 148 creative-point forward hardening', () => {
  it('backfills only from immutable reserve intent and fails when evidence is missing', () => {
    expect(sql).toContain("o.request->>'rate_card_version'")
    expect(sql).toContain("o.kind = 'reserve'")
    expect(sql).toContain('lacks authoritative rate-card evidence')
    expect(sql).toContain('ALTER COLUMN rate_card_version SET NOT NULL')
    expect(sql).not.toMatch(/DEFAULT\s+["']legacy/iu)
  })

  it('installs the allocation bounds trigger as a forward migration', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION validate_creative_point_allocation()')
    expect(sql).toContain('CREATE TRIGGER creative_point_allocations_validate')
    expect(sql).toContain('FOR UPDATE')
  })
})
