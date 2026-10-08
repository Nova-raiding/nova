import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

describe('browser suite completeness', () => {
  it('includes Ops public-rule upload in the full browser run', () => {
    // Regression: ISSUE-001 — test:browser:all omitted the dedicated Ops rule-upload journey.
    // Found by /qa on 2026-10-08.
    // Report: .gstack/qa-reports/qa-report-project-regression-2026-10-08.md
    const suite = packageJson.scripts['test:browser:all']
    expect(suite).toBeTypeOf('string')
    expect(suite?.split('&&').map(command => command.trim())).toContain('npm run test:browser:ops:rule-upload')
    expect(packageJson.scripts['test:browser:ops:rule-upload']).toContain('ops-rule-upload-isolated.spec.js')
  })
})
