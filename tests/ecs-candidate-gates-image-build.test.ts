import { describe, expect, it } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

describe('ECS candidate gate image construction', () => {
  it('uses a portable mktemp template with trailing placeholders', () => {
    const source = readFileSync('infra/scripts/build-ecs-candidate-gates-image.sh', 'utf8')
    expect(source).toContain('archive=$(mktemp "${TMPDIR:-/tmp}/candidate-source.XXXXXXXX")')
    expect(source).not.toContain('candidate-source.XXXXXXXX.tar')
  })
  it('pins the toolchain, installs from the root lockfile, and runs as the gate user', () => {
    const dockerfile = readFileSync('infra/docker/candidate-gates.Dockerfile', 'utf8')
    expect(dockerfile).toMatch(/^FROM node:22-alpine@sha256:[a-f0-9]{64}$/m)
    expect(dockerfile).toContain('RUN npm ci --no-audit --fund=false')
    expect(dockerfile).toContain('USER 65534:65534')
    expect(dockerfile).toContain('com.storenova.candidate.source_sha256')
  })

  it('excludes local secrets and generated evidence from the COPY . . build context', () => {
    // `candidate-gates.Dockerfile` is the only Dockerfile that copies the whole
    // repository. Docker replaces the root ignore file with
    // `<dockerfile>.dockerignore` when one exists, so the sidecar must carry the
    // same exclusions or a manual `docker build .` ships `.env` into the image.
    for (const path of ['.dockerignore', 'infra/docker/candidate-gates.Dockerfile.dockerignore']) {
      const ignore = readFileSync(path, 'utf8')
      const lines = ignore.split('\n').map(line => line.trim())
      for (const entry of ['.env', '.env.*', '.env.production-config-path', 'test-results', '.codegraph', '*.tar.gz', 'screenshots', '*-inventory.json', '.DS_Store']) {
        expect(lines, `${path} must exclude ${entry}`).toContain(entry)
      }
      // The tracked, secret-free template must survive the `.env.*` rule.
      expect(lines, `${path} must re-include .env.example`).toContain('!.env.example')
      expect(lines.indexOf('!.env.example'), `${path}: negation must follow .env.*`).toBeGreaterThan(lines.indexOf('.env.*'))
    }
    const dockerfile = readFileSync('infra/docker/candidate-gates.Dockerfile', 'utf8')
    expect(dockerfile).toContain('RUN test ! -e .env')
    expect(dockerfile).toContain('test ! -e .env.production-config-path')
    expect(dockerfile.indexOf('RUN test ! -e .env')).toBeLessThan(dockerfile.indexOf('RUN npm ci'))
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
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\ncase "$1 $2" in\n  'build --pull=false') exit 0;;\n  'image inspect')\n    case "$*" in\n      *org.opencontainers.image.revision*) printf '%s\\n' '${revision}' ;;\n      *com.storenova.candidate.source_sha256*) printf '%s\\n' 'sha256:${sourceSha}' ;;\n      *com.storenova.candidate.cloud_source_v2*) printf '%s\\n' '0' ;;\n    esac\n    exit 0;;\nesac\nexit 1\n`, { mode: 0o755 })

    const result = spawnSync('sh', [join(root, 'infra/scripts/build-ecs-candidate-gates-image.sh')], {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, ECS_CANDIDATE_GIT_SHA: revision },
      encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`revision=${revision}`)
  })

  it('refuses a v2 gate image when the bundled cloud archive still contains local plugin source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'candidate-cloud-image-build-'))
    const root = join(dir, 'repo')
    const bundle = join(dir, 'bundle')
    const bin = join(dir, 'bin')
    mkdirSync(join(root, 'infra/scripts'), { recursive: true })
    mkdirSync(join(root, 'infra/docker'), { recursive: true })
    mkdirSync(join(root, 'apps/plugin'), { recursive: true })
    mkdirSync(bundle)
    mkdirSync(bin)
    cpSync(resolve('infra/scripts/build-ecs-candidate-gates-image.sh'), join(root, 'infra/scripts/build-ecs-candidate-gates-image.sh'))
    cpSync(resolve('infra/docker/candidate-gates.Dockerfile'), join(root, 'infra/docker/candidate-gates.Dockerfile'))
    writeFileSync(join(root, 'apps/plugin/bridge.mjs'), 'export {}\n')
    spawnSync('git', ['init', '-q'], { cwd: root })
    spawnSync('git', ['add', '.'], { cwd: root })
    spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'candidate'], { cwd: root })
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
    const archive = join(bundle, 'candidate-source.tar')
    const archived = spawnSync('git', ['archive', '--format=tar', '-o', archive, revision], { cwd: root, encoding: 'utf8' })
    expect(archived.status, archived.stderr).toBe(0)
    const sourceSha = spawnSync('shasum', ['-a', '256', archive], { encoding: 'utf8' }).stdout.split(/\s+/u)[0]
    writeFileSync(join(bundle, 'candidate-identity.txt'), `git_sha=${revision}\nsource_sha256=sha256:${sourceSha}\nschema_version=candidate-identity/2\n`)
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\necho "docker must not be invoked" >&2\nexit 99\n', { mode: 0o755 })
    const result = spawnSync('sh', [join(root, 'infra/scripts/build-ecs-candidate-gates-image.sh')], {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, ECS_CANDIDATE_GIT_SHA: revision, ECS_CLOUD_SOURCE_V2: '1', ECS_CANDIDATE_BUNDLE_DIR: bundle },
      encoding: 'utf8',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('cloud candidate archive contains local plugin source')
    expect(result.stderr).not.toContain('docker must not be invoked')
  })
})
