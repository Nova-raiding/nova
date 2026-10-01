import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const source = readFileSync(resolve(root, 'scripts/e2e-readonly-matrix.ts'), 'utf8')
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }

describe('read-only E2E matrix entrypoint', () => {
  it('is exposed as a package script and uses the typed runner', () => {
    expect(packageJson.scripts['test:e2e:readonly']).toBe('node --import tsx scripts/e2e-readonly-matrix.ts')
  })

  it('covers every requested product surface', () => {
    for (const area of ['plugin', 'api-mcp', 'merchant-ui', 'ops-ui', 'authorization', 'payments', 'model']) {
      expect(source).toContain(`area: '${area}'`)
    }
  })

  it('hardens the runner to read-only commands and environment', () => {
    expect(source).toContain("E2E_READONLY: '1'")
    expect(source).toContain("READ_ONLY_E2E: '1'")
    expect(source).toContain('const forbidden =')
    expect(source).toContain("process.exitCode = report.failed === 0 ? 0 : 1")
  })
})
