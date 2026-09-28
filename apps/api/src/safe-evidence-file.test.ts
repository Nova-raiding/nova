import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_RUNTIME_EVIDENCE_BYTES, readSafeRuntimeEvidenceFile } from './safe-evidence-file.js'

const directories: string[] = []
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'runtime-evidence-'))
  directories.push(path)
  return path
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('readSafeRuntimeEvidenceFile', () => {
  it('reads a bounded regular file at and below the configured limit', () => {
    const path = join(directory(), 'evidence.json')
    const contents = 'x'.repeat(MAX_RUNTIME_EVIDENCE_BYTES)
    writeFileSync(path, contents)
    expect(readSafeRuntimeEvidenceFile(path)).toBe(contents)
  })

  it('rejects an oversized file before reading it', () => {
    const path = join(directory(), 'evidence.json')
    writeFileSync(path, 'x'.repeat(MAX_RUNTIME_EVIDENCE_BYTES + 1))
    expect(() => readSafeRuntimeEvidenceFile(path)).toThrow()
  })

  it('rejects symlinks, directories, and relative paths', () => {
    const root = directory()
    const target = join(root, 'target.json')
    writeFileSync(target, '{}')
    const link = join(root, 'linked.json')
    symlinkSync(target, link)
    const dir = join(root, 'nested')
    mkdirSync(dir)
    expect(() => readSafeRuntimeEvidenceFile(link)).toThrow()
    expect(() => readSafeRuntimeEvidenceFile(dir)).toThrow()
    expect(() => readSafeRuntimeEvidenceFile('relative/evidence.json')).toThrow()
  })
})
