import { describe, expect, it } from 'vitest'
import { collectReleaseMetadata, validateReleaseMetadata } from './release-metadata-gate.js'

describe('migration release metadata identity gate', () => {
  it('rejects duplicate migration names even when the version is different', () => {
    const snapshot = collectReleaseMetadata()
    expect(validateReleaseMetadata({
      ...snapshot,
      migrationFiles: [...snapshot.migrationFiles, '124_initial.sql'],
    })).toContain('migration chain contains duplicate name initial')
  })
})
