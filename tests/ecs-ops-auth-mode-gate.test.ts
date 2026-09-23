import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const gate = resolve('infra/scripts/verify-ecs-ops-ui-auth-mode.sh')
const image = `registry.example.test/storenova/merchant-ops-ui@sha256:${'a'.repeat(64)}`

function verify(mode: string, imageRef = image, imageMode = 'password') {
  const bin = mkdtempSync(join(tmpdir(), 'ecs-ops-auth-gate-'))
  const docker = join(bin, 'docker')
  writeFileSync(docker, '#!/bin/sh\n[ "$1 $2" = "image inspect" ] || exit 10\n[ "$3" = "--format" ] || exit 11\nprintf "%s\\n" "$TEST_IMAGE_AUTH_MODE"\n')
  chmodSync(docker, 0o700)
  return spawnSync('sh', [gate, imageRef, mode], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, TEST_IMAGE_AUTH_MODE: imageMode },
  })
}

describe('ECS ops authentication image binding', () => {
  it('uses the same mode in compiled UI metadata and final image label, verified by preflight', () => {
    const dockerfile = readFileSync(resolve('infra/docker/ops-console.Dockerfile'), 'utf8')
    const preflight = readFileSync(resolve('infra/scripts/deploy-preflight-ecs.sh'), 'utf8')
    expect(dockerfile).toContain('"auth_mode":"%s"')
    expect(dockerfile).toContain('LABEL com.storenova.ops.auth_mode=$OPS_CONSOLE_AUTH_MODE')
    expect(preflight).toContain('sh infra/scripts/verify-ecs-ops-ui-auth-mode.sh "$OPS_UI_IMAGE_REF" "$OPS_AUTH_MODE"')
    expect(verify('password').status).toBe(0)
  })

  it('rejects mismatched and absent image modes and mutable references', () => {
    expect(verify('password', image, 'oidc').status).not.toBe(0)
    expect(verify('password', image, '').status).not.toBe(0)
    expect(verify('password', 'registry.example.test/merchant-ops-ui:latest').status).not.toBe(0)
    expect(verify('local').status).not.toBe(0)
  })
})
