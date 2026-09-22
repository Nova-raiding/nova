import { cpSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('ECS candidate bundle contract', () => {
  it('stays ECS-only and records that alerts are disabled', () => {
    const script = readFileSync('infra/scripts/prepare-ecs-candidate-bundle.sh', 'utf8')
    const manifest = script.slice(script.indexOf("cat > \"$manifest\" <<'EOF'"), script.indexOf('\nEOF', script.indexOf("cat > \"$manifest\" <<'EOF'")))

    expect(manifest).not.toMatch(/kubernetes|kubectl|aliyun-ack-rrsa/u)
    expect(script).toContain('This candidate is ECS-only')
    expect(script).toContain('Alerts are disabled for this candidate')
    expect(script).not.toContain('alert delivery, and rollback')
  })

  it('binds a clean committed full-source archive to the same digest used by the gate image', () => {
    const script = readFileSync('infra/scripts/prepare-ecs-candidate-bundle.sh', 'utf8')

    expect(script).toContain("status --porcelain --untracked-files=normal")
    expect(script).toContain('candidate bundle requires a clean committed source tree')
    expect(script).toContain("git -C \"$root\" archive --format=tar \"$revision\" \\")
    expect(script).toContain("':(exclude)artifacts'")
    expect(script).not.toContain("':(exclude)dogfood'")
    expect(script).toContain("':(exclude)screenshots'")
    expect(script).not.toContain('tar -C "$root" -czf "$archive" -T "$manifest"')
    expect(script).toContain('source_sha256=sha256:$archive_sha')
    expect(script).toContain('comparison_manifest_sha256=sha256:$manifest_sha')
    expect(script).toContain('sync_plan_sha256=sha256:$report_sha')
    expect(readFileSync('infra/scripts/build-ecs-candidate-gates-image.sh', 'utf8')).toContain(
      "git -C \"$root\" archive --format=tar \"$revision\" \\",
    )
    expect(readFileSync('infra/scripts/build-ecs-release-images.sh', 'utf8')).toContain(
      "git -C \"$root\" archive --format=tar \"$revision\" \\",
    )
    expect(readFileSync('infra/scripts/deploy-verified-ecs-compose.sh', 'utf8')).toContain(
      "git -C \"$root\" archive --format=tar \"$git_sha\" \\",
    )
  })

  it('puts the verified ECS deployment and evidence trust chain in the review manifest', () => {
    const script = readFileSync('infra/scripts/prepare-ecs-candidate-bundle.sh', 'utf8')
    const manifest = script.slice(script.indexOf("cat > \"$manifest\" <<'EOF'"), script.indexOf('\nEOF', script.indexOf("cat > \"$manifest\" <<'EOF'")))
    for (const path of [
      'infra/scripts/render-ecs-production-compose.sh',
      'infra/scripts/stage-verified-ecs-release.sh',
      'infra/scripts/check-ecs-storage-budget.sh',
      'infra/scripts/build-ecs-release-images.sh',
      'infra/scripts/prepare-ecs-eight-image-set.mjs',
      'infra/scripts/capture-manual-operations-evidence.sh',
      'infra/scripts/deploy-verified-ecs-compose.sh',
      'infra/scripts/rollback-ecs-compose.sh',
      'infra/scripts/invoke-ecs-automatic-rollback.sh',
      'infra/scripts/install-ecs-release-controls.mjs',
      'infra/scripts/install-ecs-release-controls.d.mts',
      'infra/scripts/test-ecs-release-control-installer.sh',
      'infra/protected/attest-release-evidence-bundle.mjs',
      'infra/protected/attest-release-evidence-bundle.d.mts',
      'infra/protected/attest-postgres-backup.mjs',
      'infra/protected/attest-postgres-backup.d.mts',
      'infra/protected/ecs-preidentity-recovery.mjs',
      'infra/protected/ecs-preidentity-recovery.d.mts',
      'tests/release-evidence-bundle-gate.ts',
      'tests/ecs-release-control-installer.container-check.mjs',
      'tests/ecs-release-control-installer.test.ts',
      'tests/postgres-backup-attester.test.ts',
      'tests/postgres-backup-attester-cli-e2e.sh',
      'tests/ecs-preidentity-recovery.test.ts',
      'tests/run-ecs-preidentity-isolated-cli.sh',
      'tests/fixtures/ecs-preidentity-isolated/docker.mjs',
      'tests/fixtures/ecs-preidentity-isolated/psql.mjs',
      'tests/fixtures/ecs-preidentity-isolated/setup.mjs',
      'tests/worker-apk-repository.test.ts',
      'scripts/model-relay-recovery-evidence.ts',
      'docs/runbooks/ecs-verified-compose-deploy.md',
      'docs/runbooks/ecs-release-evidence-bundle-attester.md',
      'docs/runbooks/ecs-release-image-build.md',
    ]) expect(manifest).toContain(path)
  })

  it('keeps host deployment entrypoints executable while verifier modules remain data', () => {
    for (const path of [
      'infra/scripts/render-ecs-production-compose.sh',
      'infra/scripts/stage-verified-ecs-release.sh',
      'infra/scripts/check-ecs-storage-budget.sh',
      'infra/scripts/deploy-verified-ecs-compose.sh',
      'infra/scripts/rollback-ecs-compose.sh',
      'infra/scripts/invoke-ecs-automatic-rollback.sh',
      'infra/protected/attest-release-evidence-bundle.mjs',
    ]) expect(statSync(path).mode & 0o111, `${path} must be executable in the release tree`).not.toBe(0)
    expect(statSync('tests/release-evidence-bundle-gate.ts').mode & 0o111).toBe(0)
  })

  it('fails before remote access when the candidate repository has uncommitted input', () => {
    const root = mkdtempSync(join(tmpdir(), 'ecs-candidate-dirty-'))
    mkdirSync(join(root, 'infra/scripts'), { recursive: true })
    cpSync(resolve('infra/scripts/prepare-ecs-candidate-bundle.sh'), join(root, 'infra/scripts/prepare-ecs-candidate-bundle.sh'))
    spawnSync('git', ['init', '-q'], { cwd: root })
    spawnSync('git', ['add', '.'], { cwd: root })
    spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'candidate'], { cwd: root })
    writeFileSync(join(root, 'uncommitted.txt'), 'not reviewed\n')

    const result = spawnSync('sh', [join(root, 'infra/scripts/prepare-ecs-candidate-bundle.sh'), join(root, 'output')], {
      env: { ...process.env, ECS_CANDIDATE_REMOTE_ALIAS: 'must-not-connect.invalid' },
      encoding: 'utf8',
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('candidate bundle requires a clean committed source tree')
    expect(result.stderr).not.toContain('ssh')
  })

  it.each([
    { root: "/opt/merchant-deploy' ; touch /tmp/unsafe ; : '", alias: '101', reason: 'unsafe characters' },
    { root: '/opt/../merchant-deploy', alias: '101', reason: 'canonical' },
    { root: '/opt//merchant-deploy', alias: '101', reason: 'canonical' },
    { root: '/opt/merchant-deploy', alias: '-oProxyCommand=unsafe', reason: 'safe SSH host' },
  ])('rejects unsafe remote shell inputs before SSH: $root $alias', ({ root, alias, reason }) => {
    const result = spawnSync('sh', ['infra/scripts/prepare-ecs-candidate-bundle.sh'], {
      env: { ...process.env, ECS_CANDIDATE_REMOTE_ROOT: root, ECS_CANDIDATE_REMOTE_ALIAS: alias },
      encoding: 'utf8',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(reason)
  })
})
