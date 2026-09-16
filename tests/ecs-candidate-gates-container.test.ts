import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const image = `example.invalid/release-gates@sha256:${'a'.repeat(64)}`
const revision = 'b'.repeat(40)
const sourceSha = `sha256:${'c'.repeat(64)}`

function run(overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ecs-gates-'))
  const log = join(dir, 'docker-args')
  writeFileSync(join(dir, 'docker'), `#!/bin/sh\nif [ "$1" = image ]; then case "$@" in *source_sha256*) printf '%s\\n' '${sourceSha}';; *) printf '%s\\n' '${revision}';; esac; exit 0; fi\nprintf '%s\\n' "$@" > '${log}'\n`, { mode: 0o755 })
  const env = {
    PATH: `${dir}:${process.env.PATH ?? ''}`,
    ECS_CANDIDATE_GATE_IMAGE: image,
    ECS_CANDIDATE_GIT_SHA: revision,
    ECS_CANDIDATE_SOURCE_SHA256: sourceSha,
    ...overrides,
  }
  const result = spawnSync('sh', ['infra/scripts/run-ecs-candidate-gates-container.sh'], { env, encoding: 'utf8' })
  return { result, log }
}

describe('ECS candidate gate container runner', () => {
  it('admits only a digest-pinned image at the expected full revision', () => {
    expect(run().result.status).toBe(0)
    expect(run({ ECS_CANDIDATE_GATE_IMAGE: 'example.invalid/release-gates:latest' }).result.status).not.toBe(0)
    expect(run({ ECS_CANDIDATE_GIT_SHA: 'short' }).result.status).not.toBe(0)
    expect(run({ ECS_CANDIDATE_SOURCE_SHA256: 'untrusted' }).result.status).not.toBe(0)
    expect(run({ ECS_CANDIDATE_SOURCE_SHA256: `sha256:${'d'.repeat(64)}` }).result.status).not.toBe(0)
  })

  it('does not grant network, Docker socket, host mounts, privilege or credentials', () => {
    const { result, log } = run()
    expect(result.status).toBe(0)
    const args = spawnSync('cat', [log], { encoding: 'utf8' }).stdout
    expect(args).toContain('--network=none')
    // TypeScript writes dist and tsbuildinfo in the source tree, and release
    // tests can create artifact fixtures. Only the disposable container layer
    // is writable; no host path is mounted.
    expect(args).not.toContain('--read-only')
    expect(args).toContain('--cap-drop=ALL')
    expect(args).toContain('--pull=never')
    expect(args).toContain('--user=65534:65534')
    expect(args).not.toContain('--volume')
    expect(args).not.toContain('--mount')
    expect(args).not.toContain('--env')
    expect(args).not.toContain('docker.sock')
    expect(run({ DATABASE_URL: 'postgres://example' }).result.status).not.toBe(0)
    expect(run({ PRODUCTION_EVIDENCE_TEST_HOOK: '1' }).result.status).not.toBe(0)
  })
})
