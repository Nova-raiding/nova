import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { releaseGitShaForRoot } from '../scripts/release-identity.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('candidate release identity trust boundary', () => {
  it('rejects a symlinked identity file even when its target has matching candidate fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-identity-symlink-'))
    roots.push(root)
    mkdirSync(join(root, 'release'))
    const gitSha = 'a'.repeat(40)
    const identity = [
      'release_id=release-1',
      `git_sha=${gitSha}`,
      `source_sha256=sha256:${'b'.repeat(64)}`,
      `comparison_manifest_sha256=sha256:${'c'.repeat(64)}`,
      `sync_plan_sha256=sha256:${'d'.repeat(64)}`,
      '',
    ].join('\n')
    const externalIdentity = join(root, 'release', 'identity')
    writeFileSync(externalIdentity, identity)
    symlinkSync(externalIdentity, join(root, '.candidate-identity'))

    expect(releaseGitShaForRoot(root, 'release-1')).toBe('')
  })
})
