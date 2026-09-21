import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(import.meta.dirname, '../scripts/invariant-mutation-gate.ts'), 'utf8')

describe('invariant mutation gate liveness safeguards', () => {
  it('bounds every evidence subprocess and reports a diagnostic timeout', () => {
    expect(source).toContain('timeout: evidenceTimeoutMs')
    expect(source).toContain('killSignal: \'SIGTERM\'')
    expect(source).toContain('evidence process timed out after')
  })

  it('reports the phase before each potentially blocking evidence run', () => {
    for (const phase of ['baseline', 'guard mutation', 'restored tree', 'over-rejection mutation', 'code + rule mutation']) {
      expect(source).toContain(`runStage('${phase}')`)
    }
    expect(source).toContain('timeout ${evidenceTimeoutMs}ms')
  })

  it('keeps cleanup in the row and process termination paths', () => {
    expect(source).toContain('finally {\n    restoreAll()\n  }')
    expect(source).toContain("process.on('exit', () => { restoreAll(); releasing?.() })")
  })
})
