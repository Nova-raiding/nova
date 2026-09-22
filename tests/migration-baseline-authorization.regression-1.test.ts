import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('migration baseline authorization', () => {
  it('ignores operator checksum entries unless baseline acceptance is explicit', () => {
    // Regression: ISSUE-002 — checksum entries bypassed the explicit baseline acceptance flag
    // Found by /qa on 2026-09-22
    // Report: .gstack/qa-reports/qa-report-yxsona-com-2026-09-22.md
    const script = readFileSync('infra/scripts/apply-migrations.sh', 'utf8')
    const acceptedChecksums = script.slice(script.indexOf('accepted_checksums()'), script.indexOf('concurrent_index_probe()'))
    const approval = acceptedChecksums.indexOf('if [ "$baseline_accepted" -eq 1 ]; then')
    const customEntries = acceptedChecksums.indexOf('for entry in $(printf')
    const approvalEnd = acceptedChecksums.lastIndexOf('\n  fi')

    expect(approval).toBeGreaterThanOrEqual(0)
    expect(customEntries).toBeGreaterThan(approval)
    expect(customEntries).toBeLessThan(approvalEnd)
  })

  it('requires baseline acceptance for the legacy migration 014 alias', () => {
    const script = readFileSync('infra/scripts/verify-database-migration-chain.sh', 'utf8')

    expect(script).toContain('!(baseline_accepted == 1 && legacy_name)')
  })
})
