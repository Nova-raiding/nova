import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { canReadEvidenceAsApi, verifyEvidenceReadableByApi } from '../infra/scripts/verify-ecs-evidence-readable-by-api.mjs'

test('API evidence read policy follows owner, group, then other permission precedence', () => {
  assert.equal(canReadEvidenceAsApi({ uid: 10001, gid: 1, mode: 0o100400 }), true)
  assert.equal(canReadEvidenceAsApi({ uid: 10001, gid: 1, mode: 0o100600 }), false)
  assert.equal(canReadEvidenceAsApi({ uid: 1, gid: 10001, mode: 0o100040 }), true)
  assert.equal(canReadEvidenceAsApi({ uid: 1, gid: 10001, mode: 0o100060 }), false)
  assert.equal(canReadEvidenceAsApi({ uid: 1, gid: 1, mode: 0o100004 }), true)
  assert.equal(canReadEvidenceAsApi({ uid: 1, gid: 1, mode: 0o100006 }), false)
  assert.equal(canReadEvidenceAsApi({ uid: 1, gid: 1, mode: 0o100600 }), false)
})

test('requires a non-empty regular readable file and rejects symlinks', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ecs-evidence-api-read-')))
  try {
    const evidence = join(directory, 'evidence.json')
    writeFileSync(evidence, '{"release_id":"release-test"}\n', { mode: 0o444 })
    assert.equal(verifyEvidenceReadableByApi(evidence).readable, true)

    chmodSync(evidence, 0o600)
    assert.throws(() => verifyEvidenceReadableByApi(evidence), /NOT_READABLE_BY_API_UID_10001_GID_10001/u)

    const link = join(directory, 'evidence-link.json')
    symlinkSync(evidence, link)
    assert.throws(() => verifyEvidenceReadableByApi(link), /EVIDENCE_PATH_MUST_BE_CANONICAL_ABSOLUTE/u)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
