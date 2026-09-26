import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = resolve('infra/scripts/build-ecs-release-images.sh')

function releaseRevision(): string {
  const identityPath = resolve('.candidate-identity')
  if (existsSync(identityPath)) {
    const identity = readFileSync(identityPath, 'utf8')
    const revision = /^git_sha=([0-9a-f]{40})$/mu.exec(identity)?.[1]
    if (!revision || !/^release_id=(?:release|ecs)-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/mu.test(identity) || !/^source_sha256=sha256:[0-9a-f]{64}$/mu.test(identity) || !existsSync(resolve('.candidate-source.tar'))) {
      throw new Error('staged candidate identity is incomplete')
    }
    return revision
  }
  const result = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' })
  const revision = result.stdout.trim()
  if (result.status !== 0 || !/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error('release image tests require a Git checkout or a staged candidate identity')
  }
  return revision
}

describe('bounded ECS release image builder', () => {
  it('builds the complete repository-owned image set, binds source identity, and bounds cache', () => {
    const source = readFileSync(script, 'utf8')
    const merchantUiDockerfile = readFileSync('infra/docker/ui.Dockerfile', 'utf8')
    const opsUiDockerfile = readFileSync('infra/docker/ops-console.Dockerfile', 'utf8')
    expect(merchantUiDockerfile).toContain('npm_config_maxsockets=2')
    expect(merchantUiDockerfile).toContain('NODE_OPTIONS=--max-old-space-size=1024')
    expect(merchantUiDockerfile).toContain('npm ci --prefer-offline --no-audit --fund=false --maxsockets=2')
    expect(merchantUiDockerfile).toContain('id=merchant-ui-npm-cache,target=/root/.npm')
    expect(opsUiDockerfile).toContain('id=merchant-ops-ui-npm-cache,target=/root/.npm')
    for (const artifact of ['merchant-api', 'merchant-worker', 'merchant-ui', 'merchant-ops-ui', 'payment-gateway', 'pilot-gateway']) {
      expect(source).toContain(`build_image ${artifact} `)
    }
    expect(source).toContain("git -C \"$root\" archive --format=tar \"$revision\" \\")
    expect(source).toContain("':(exclude)artifacts'")
    expect(source).not.toContain("':(exclude)dogfood'")
    expect(source).toContain("':(exclude)screenshots'")
    expect(source).toContain('cp "$source_archive" "$archive"')
    expect(source).toContain('candidate source archive digest mismatch')
    expect(source).toContain('candidate identity release ID does not match RELEASE_ID')
    expect(source).toContain('[ ! -L "$source_archive" ]')
    expect(source).toContain('com.storenova.release.source_sha256=sha256:$source_sha')
    expect(source).toContain('docker builder prune -f --keep-storage "$cache_limit"')
    expect(source).toContain('docker image rm $built_tags')
    expect(source).not.toMatch(/docker (compose|stack|run) /u)
    expect(source).toContain("atomicWrite('repository-image-digests.json'")
    expect(source).toContain("flag: 'wx'")
    expect(source).toContain('ECS release image output directory must not already exist')
    expect(source).toContain('ECS_OPS_AUTH_MODE')
    expect(source).toContain('com.storenova.ops.auth_mode')
    expect(source).toContain('--build-arg "OPS_CONSOLE_AUTH_MODE=$ops_auth_mode"')
    expect(source).toContain('--build-arg "NPM_CONFIG_REGISTRY=$npm_registry"')
    expect(source).toContain('npm_registry: process.env.NPM_REGISTRY')
    expect(source).toContain('--label "com.storenova.ops-auth-mode=$ops_auth_mode"')
    expect(source).not.toContain('VITE_OPS_LOGIN_URL')
  })

  it('refuses mutable or unsafe release identity before Docker is invoked', () => {
    const result = spawnSync('sh', [script], {
      env: {
        ...process.env,
        ECS_RELEASE_GIT_SHA: 'a'.repeat(40),
        RELEASE_ID: 'not-a-release',
        ECS_RELEASE_IMAGE_REPOSITORY: 'registry.example.com/storenova',
      },
      encoding: 'utf8',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('RELEASE_ID must be a safe release-* or ecs-* identifier')
  })

  it('refuses a pre-created output path before pushing images', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ecs-release-existing-output-'))
    const marker = join(directory, 'keep-existing-output-data')
    writeFileSync(marker, 'preserve this pre-existing content')
    const result = spawnSync('sh', [script], {
      env: {
        ...process.env,
        ECS_RELEASE_GIT_SHA: releaseRevision(),
        RELEASE_ID: 'release-existing',
        ECS_RELEASE_IMAGE_REPOSITORY: 'registry.example.com/storenova',
        ECS_RELEASE_IMAGE_OUTPUT_DIR: directory,
        ECS_OPS_AUTH_MODE: 'password',
        OPS_AUTH_MODE: 'password',
      },
      encoding: 'utf8',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('output directory must not already exist')
    expect(readFileSync(marker, 'utf8')).toBe('preserve this pre-existing content')
  })

  it('rejects non-password Ops authentication before Docker is invoked', () => {
    const result = spawnSync('sh', [script], {
      env: {
        ...process.env,
        ECS_RELEASE_GIT_SHA: releaseRevision(),
        RELEASE_ID: 'release-unsafe-ops-login',
        ECS_RELEASE_IMAGE_REPOSITORY: 'registry.example.com/storenova',
        ECS_RELEASE_IMAGE_OUTPUT_DIR: join(mkdtempSync(join(tmpdir(), 'ecs-ops-login-parent-')), 'output'),
        ECS_OPS_AUTH_MODE: 'oidc',
      },
      encoding: 'utf8',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('ECS_OPS_AUTH_MODE must be password')
  })

  it('does not expose an external Ops login URL build input', () => {
    expect(readFileSync(script, 'utf8')).not.toContain('ECS_OPS_UI_LOGIN_URL')
    expect(readFileSync('infra/docker/ops-console.Dockerfile', 'utf8')).not.toContain('VITE_OPS_LOGIN_URL')
  })

  it('publishes immutable references and an atomic six-image digest manifest', () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ecs-release-image-build-')))
    const root = join(directory, 'repo')
    const bin = join(directory, 'bin')
    const output = join(directory, 'output')
    const releaseId = 'ecs-00154548'
    mkdirSync(join(root, 'infra/scripts'), { recursive: true })
    mkdirSync(join(root, 'infra/docker'), { recursive: true })
    mkdirSync(join(root, 'services/payment-gateway'), { recursive: true })
    mkdirSync(bin)
    cpSync(resolve('infra/scripts/ecs-build-lock.sh'), join(root, 'infra/scripts/ecs-build-lock.sh'))
    writeFileSync(join(root, 'infra/scripts/build-ecs-release-images.sh'), readFileSync(script))
    chmodSync(join(root, 'infra/scripts/build-ecs-release-images.sh'), 0o755)
    for (const path of ['infra/docker/api.Dockerfile', 'infra/docker/worker.Dockerfile', 'infra/docker/ui.Dockerfile', 'infra/docker/ops-console.Dockerfile', 'infra/docker/pilot-gateway-https.Dockerfile', 'services/payment-gateway/Dockerfile']) {
      writeFileSync(join(root, path), 'FROM scratch\n')
    }
    spawnSync('git', ['init', '-q'], { cwd: root })
    spawnSync('git', ['add', '.'], { cwd: root })
    spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'release'], { cwd: root })
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
    const log = join(directory, 'docker.log')
    const digest = `sha256:${'d'.repeat(64)}`
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$1 $2" in\n  'builder prune') [ "${'$'}{MOCK_DOCKER_FAIL_PRUNE:-NO}" != YES ] || exit 1; exit 0;;\n  'build --pull=false'|'push registry.example.com/storenova/merchant-api:${releaseId}'|'push registry.example.com/storenova/merchant-worker:${releaseId}'|'push registry.example.com/storenova/merchant-ui:${releaseId}'|'push registry.example.com/storenova/merchant-ops-ui:${releaseId}'|'push registry.example.com/storenova/payment-gateway:${releaseId}'|'push registry.example.com/storenova/pilot-gateway:${releaseId}'|'image rm') exit 0;;\n  'image inspect')\n    case "$*" in\n      *org.opencontainers.image.revision*) printf '%s\\n' '${revision}' ;;\n      *com.storenova.release.id*) printf '%s\\n' '${releaseId}' ;;\n      *com.storenova.release.source_sha256*) printf '%s\\n' "$SOURCE_SHA" ;;
      *com.storenova.ops.auth_mode*) printf '%s\\n' 'password' ;;\n      *RepoDigests*) printf '%s@${digest}\\n' "${'$'}{5%:${releaseId}}" ;;\n    esac\n    exit 0;;\nesac\nexit 1\n`)
    chmodSync(join(bin, 'docker'), 0o755)
    const archive = spawnSync('git', ['archive', '--format=tar', revision], { cwd: root }).stdout
    const sha = spawnSync('shasum', ['-a', '256'], { input: archive, encoding: 'utf8' }).stdout.split(/\s/u)[0]
    writeFileSync(join(root, '.candidate-source.tar'), archive)
    writeFileSync(join(root, '.candidate-identity'), `release_id=${releaseId}\ngit_sha=${revision}\nsource_sha256=sha256:${sha}\n`)

    const buildEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      SOURCE_SHA: `sha256:${sha}`,
      ECS_RELEASE_GIT_SHA: revision,
      ECS_RELEASE_IMAGE_REPOSITORY: 'registry.example.com/storenova',
      ECS_BUILD_LOCK_PATH: join(directory, 'build.lock'),
      ECS_BUILD_CACHE_KEEP_STORAGE: '1GB',
      ECS_OPS_AUTH_MODE: 'password',
      ECS_NPM_REGISTRY: 'https://registry.npmmirror.com/',
    }
    const mismatchedIdentity = spawnSync('sh', [join(root, 'infra/scripts/build-ecs-release-images.sh')], {
      cwd: directory,
      env: { ...buildEnv, RELEASE_ID: 'release-00154548', ECS_RELEASE_IMAGE_OUTPUT_DIR: join(directory, 'mismatch-output') },
      encoding: 'utf8',
    })
    expect(mismatchedIdentity.status).not.toBe(0)
    expect(mismatchedIdentity.stderr).toContain('candidate identity release ID does not match RELEASE_ID')
    expect(existsSync(log)).toBe(false)
    expect(existsSync(join(directory, 'mismatch-output'))).toBe(false)

    const wrongArchive = join(directory, 'wrong-source.tar')
    writeFileSync(wrongArchive, 'not the identity-bound candidate archive')
    const archiveMismatchOutput = join(directory, 'archive-mismatch-output')
    const mismatchedArchive = spawnSync('sh', [join(root, 'infra/scripts/build-ecs-release-images.sh')], {
      cwd: directory,
      env: { ...buildEnv, RELEASE_ID: releaseId, ECS_RELEASE_IMAGE_OUTPUT_DIR: archiveMismatchOutput, ECS_RELEASE_SOURCE_ARCHIVE: wrongArchive },
      encoding: 'utf8',
    })
    expect(mismatchedArchive.status).not.toBe(0)
    expect(mismatchedArchive.stderr).toContain('candidate source archive digest mismatch')
    expect(existsSync(log)).toBe(false)
    expect(existsSync(archiveMismatchOutput)).toBe(false)

    const pruneFailureOutput = join(directory, 'prune-failure-output')
    const pruneFailure = spawnSync('sh', [join(root, 'infra/scripts/build-ecs-release-images.sh')], {
      cwd: directory,
      env: { ...buildEnv, RELEASE_ID: releaseId, ECS_RELEASE_IMAGE_OUTPUT_DIR: pruneFailureOutput, MOCK_DOCKER_FAIL_PRUNE: 'YES' },
      encoding: 'utf8',
    })
    expect(pruneFailure.status).not.toBe(0)
    expect(existsSync(pruneFailureOutput)).toBe(false)
    expect(readFileSync(log, 'utf8')).not.toContain('build --pull=false')

    const result = spawnSync('sh', [join(root, 'infra/scripts/build-ecs-release-images.sh')], {
      cwd: directory,
      env: { ...buildEnv, RELEASE_ID: releaseId, ECS_RELEASE_IMAGE_OUTPUT_DIR: output },
      encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
    const manifest = JSON.parse(readFileSync(join(output, 'release-images.json'), 'utf8'))
    expect(manifest.release_id).toBe(releaseId)
    expect(manifest.release_git_sha).toBe(revision)
    expect(manifest.npm_registry).toBe('https://registry.npmmirror.com/')
    expect(Object.keys(manifest.image_digests)).toHaveLength(6)
    expect(Object.values(manifest.image_digests)).toEqual(Array(6).fill(digest))
    const dockerLog = readFileSync(log, 'utf8')
    expect(dockerLog.match(/builder prune -f --keep-storage 1GB/gu)).toHaveLength(4)
    expect(dockerLog).toContain('--label org.opencontainers.image.revision=')
    expect(dockerLog).toContain('--label com.storenova.ops-auth-mode=password')
    expect(dockerLog).toContain('--build-arg NPM_CONFIG_REGISTRY=https://registry.npmmirror.com/')
    expect(dockerLog).not.toContain('VITE_OPS_LOGIN_URL')
    expect(dockerLog).toContain('infra/docker/pilot-gateway-https.Dockerfile')
    expect(dockerLog).not.toMatch(/compose| run /u)
  })
})
