import { chmodSync, mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const script = 'infra/scripts/restore-pg16-isolated.sh'
const sha = 'a'.repeat(64)
function fixture(verifyExit = 1, dockerMode = 'reject') {
  const root = mkdtempSync(join(tmpdir(), 'restore-pg16-shell-'))
  const bin = join(root, 'bin'); const state = join(root, 'state');
  execFileSync('mkdir', ['-p', bin, state])
  for (const file of ['backup.dump', 'backup.dump.sha256', 'backup.dump.attestation.json', 'production-evidence-public.pem', 'production-evidence-key-id']) writeFileSync(join(root, file), 'x')
  writeFileSync(join(root, 'verify.mjs'), `process.exit(${verifyExit})\n`)
  const docker = dockerMode === 'restore-fail'
    ? '#!/bin/sh\necho "$*" >> "$DOCKER_LOG"\ncase "$*" in *"image inspect"*) exit 0;; *pg_restore*) exit 7;; *) exit 0;; esac\n'
    : dockerMode === 'migration-mismatch'
      ? '#!/bin/sh\necho "$*" >> "$DOCKER_LOG"\ncase "$*" in *"image inspect"*) exit 0;; *"select max(version)::int"*) printf "241\\n"; exit 0;; *) exit 0;; esac\n'
      : dockerMode === 'happy'
        ? '#!/bin/sh\necho "$*" >> "$DOCKER_LOG"\ncase "$*" in *"image inspect"*) exit 0;; *"select max(version)::int"*) printf "242\\n"; exit 0;; *) exit 0;; esac\n'
        : '#!/bin/sh\necho "$*" >> "$DOCKER_LOG"\nexit 99\n'
  writeFileSync(join(bin, 'docker'), docker); chmodSync(join(bin, 'docker'), 0o755)
  writeFileSync(join(root, 'docker.log'), '')
  return { root, bin, state, dockerLog: join(root, 'docker.log') }
}
function env(f: ReturnType<typeof fixture>): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, DOCKER_LOG: f.dockerLog, BACKUP_FILE: join(f.root, 'backup.dump'), BACKUP_CHECKSUM_FILE: join(f.root, 'backup.dump.sha256'), BACKUP_ATTESTATION_PATH: join(f.root, 'backup.dump.attestation.json'), EXPECTED_BACKUP_SHA256: sha, EXPECTED_SOURCE_DATABASE_ID_SHA256: sha, EXPECTED_MIGRATION_VERSION: '242', POSTGRES_IMAGE_REF: 'registry.example/postgres@sha256:' + sha, VERIFY_PREVIEW_INPUTS: join(f.root, 'verify.mjs'), TRUST_DIR: f.root, RESTORE_STATE_ROOT: f.state }
}

describe('isolated restore shell fail-closed behavior', () => {
  it('does not invoke Docker when signed backup verification fails', () => {
    const f = fixture(1)
    const result = spawnSync('sh', [script], { env: env(f), encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toBeDefined()
    expect(readFileSync(f.dockerLog, 'utf8')).toBe('')
    expect(existsSync(join(f.state, 'compose.yml'))).toBe(false)
  })
  it('rejects production connection variables before Docker', () => {
    const f = fixture(0); const value = env(f); value.DATABASE_URL = 'postgresql://production.invalid/db'
    expect(() => execFileSync('sh', [script], { env: value, stdio: 'pipe' })).toThrow()
    expect(existsSync(join(f.state, 'compose.yml'))).toBe(false)
  })
  it('retains state and returns nonzero when pg_restore fails', () => {
    const f = fixture(0, 'restore-fail')
    expect(() => execFileSync('sh', [script], { env: env(f), stdio: 'pipe' })).toThrow()
    expect(readFileSync(f.dockerLog, 'utf8')).toContain('pg_restore')
    expect(existsSync(join(f.state))).toBe(true)
    const children = readdirSync(f.state); expect(children).toHaveLength(1); const child = children[0]; expect(child).toBeTruthy()
    const compose = readFileSync(join(f.state, child!, 'compose.yml'), 'utf8'); expect(compose).toContain('internal: true'); expect(compose).not.toContain('ports:')
    expect(readFileSync(f.dockerLog, 'utf8')).toContain('pg_restore')
  })
  it('returns nonzero when restored migration tail mismatches', () => {
    const f = fixture(0, 'migration-mismatch')
    expect(() => execFileSync('sh', [script], { env: env(f), stdio: 'pipe' })).toThrow()
  })
  it('completes the happy migration-242 path and tears down without deleting the volume', () => {
    const f = fixture(0, 'happy')
    const result = spawnSync('sh', [script], { env: env(f), encoding: 'utf8' })
    expect(result.status).toBe(0)
    const children = readdirSync(f.state); expect(children).toHaveLength(1); const child = children[0]; expect(child).toBeTruthy()
    const compose = readFileSync(join(f.state, child!, 'compose.yml'), 'utf8'); expect(compose).not.toContain('ports:'); expect(compose).toContain('internal: true')
    const calls = readFileSync(f.dockerLog, 'utf8'); expect(calls).toContain('pg_restore'); expect(calls).toContain('down'); expect(calls).not.toContain('down -v')
  })
})
