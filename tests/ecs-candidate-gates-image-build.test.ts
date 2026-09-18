import { describe, expect, it } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

describe('ECS candidate gate image construction', () => {
  it('pins the toolchain, installs from the root lockfile, and runs as the gate user', () => {
    const dockerfile = readFileSync('infra/docker/candidate-gates.Dockerfile', 'utf8')
    expect(dockerfile).toMatch(/^FROM node:22-alpine@sha256:[a-f0-9]{64}$/m)
    expect(dockerfile).toContain('RUN npm ci --no-audit --fund=false')
    expect(dockerfile).toContain('USER 65534:65534')
    expect(dockerfile).toContain('com.storenova.candidate.source_sha256')
  })

  it('refuses an unreviewed source revision before invoking Docker', () => {
    const result = spawnSync('sh', ['infra/scripts/build-ecs-candidate-gates-image.sh'], {
      env: { ...process.env, ECS_CANDIDATE_GIT_SHA: 'a'.repeat(40) },
      encoding: 'utf8',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('candidate revision does not match HEAD')
  })

  it('resolves the committed source from the script repository when invoked elsewhere', () => {
    const dir = mkdtempSync(join(tmpdir(), 'candidate-image-build-'))
    const root = join(dir, 'repo')
    mkdirSync(join(root, 'infra/scripts'), { recursive: true })
    mkdirSync(join(root, 'infra/docker'), { recursive: true })
    cpSync(resolve('infra/scripts/build-ecs-candidate-gates-image.sh'), join(root, 'infra/scripts/build-ecs-candidate-gates-image.sh'))
    cpSync(resolve('infra/docker/candidate-gates.Dockerfile'), join(root, 'infra/docker/candidate-gates.Dockerfile'))
    spawnSync('git', ['init', '-q'], { cwd: root })
    spawnSync('git', ['add', '.'], { cwd: root })
    spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'candidate'], { cwd: root })
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
    const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
    const sourceSha = spawnSync('sh', ['-c', `git -C "$1" archive --format=tar "$2" | shasum -a 256 | awk '{print $1}'`, 'sh', root, revision], { encoding: 'utf8' }).stdout.trim()
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" status --porcelain "*) exit 0;; esac\nexec '${realGit}' "$@"\n`, { mode: 0o755 })
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\ncase "$1 $2" in\n  'build --pull=false') exit 0;;\n  'image inspect')\n    case "$*" in\n      *org.opencontainers.image.revision*) printf '%s\\n' '${revision}' ;;\n      *com.storenova.candidate.source_sha256*) printf '%s\\n' 'sha256:${sourceSha}' ;;\n    esac\n    exit 0;;\nesac\nexit 1\n`, { mode: 0o755 })

    const result = spawnSync('sh', [join(root, 'infra/scripts/build-ecs-candidate-gates-image.sh')], {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, ECS_CANDIDATE_GIT_SHA: revision },
      encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`revision=${revision}`)
  })
})
