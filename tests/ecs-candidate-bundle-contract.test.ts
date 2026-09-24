import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
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
      'infra/scripts/ecs-build-lock.sh',
      'infra/scripts/install-ecs-staging-toolchain.mjs',
      'infra/scripts/check-ecs-storage-budget.sh',
      'infra/scripts/build-ecs-release-images.sh',
      'infra/scripts/prepare-ecs-eight-image-set.mjs',
      'infra/scripts/capture-manual-operations-evidence.sh',
      'infra/scripts/candidate-api-docker-request.mjs',
      'infra/scripts/deploy-verified-ecs-compose.sh',
      'infra/scripts/rollback-ecs-compose.sh',
      'infra/scripts/invoke-ecs-automatic-rollback.sh',
      'infra/scripts/install-ecs-release-controls.mjs',
      'infra/scripts/install-ecs-release-controls.d.mts',
      'infra/scripts/test-ecs-release-control-installer.sh',
      'tests/ecs-staging-toolchain-installer.test.mjs',
      'tests/ecs-staging-toolchain-installer.container-check.mjs',
      'tests/ecs-one-click-deploy.test.ts',
      'docs/runbooks/ecs-candidate-safe-sync.md',
      'infra/scripts/consume-production-evidence-nonce.sh',
      'infra/protected/consume-production-evidence-nonce.py',
      'tests/protected-nonce-consumer-smoke.py',
      'tests/run-protected-nonce-consumer-isolated.sh',
      'docs/runbooks/ecs-production-nonce-consumer.md',
      'docs/runbooks/ecs-bridge-b-transition.md',
      'infra/protected/attest-release-evidence-bundle.mjs',
      'infra/protected/attest-release-evidence-bundle.d.mts',
      'infra/protected/attest-postgres-backup.mjs',
      'infra/protected/attest-postgres-backup.d.mts',
      'infra/protected/attest-manual-operations-evidence.mjs',
      'infra/protected/attest-manual-operations-evidence.d.mts',
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

  it('includes changed runtime and release inputs in the remote comparison manifest', () => {
    const script = readFileSync('infra/scripts/prepare-ecs-candidate-bundle.sh', 'utf8')
    const start = script.indexOf('cat > "$manifest" <<\'EOF\'')
    const manifest = script.slice(start, script.indexOf('\nEOF', start))

    for (const path of [
      'apps/api/src/scanner-health.test.ts',
      'apps/api/src/connector-capability-evidence-trust.ts',
      'apps/api/src/connector-capability-evidence-trust.test.ts',
      'apps/api/src/ops/csv-cell.ts',
      'apps/api/src/csv-cell-injection.test.ts',
      'apps/api/src/local-plugin-auth.ts',
      'apps/api/src/local-plugin-auth.test.ts',
      'apps/api/src/local-plugin-auth.e2e.test.ts',
      'apps/api/src/local-plugin-connect-request.e2e.test.ts',
      'apps/api/src/local-plugin-instance-proof.ts',
      'apps/api/src/local-plugin-instance-proof.test.ts',
      'apps/api/src/local-plugin-installer.integration.test.ts',
      'packages/persistence/src/local-plugin-connection-repository.ts',
      'packages/persistence/src/local-plugin-connection-repository.test.ts',
      'packages/persistence/src/local-plugin-install-instance-repository.ts',
      'packages/persistence/src/local-plugin-install-instance-repository.test.ts',
      'packages/persistence/src/migrations/243_local_plugin_connection_requests.sql',
      'packages/persistence/src/migrations/244_local_plugin_install_instances.sql',
      'packages/persistence/src/migrations/245_local_plugin_authorized_timestamp.sql',
      'packages/persistence/src/local-plugin-install-rls.release.postgres.test.ts',
      'demo/merchant-studio/package.json',
      'demo/merchant-studio/src/App.tsx',
      'demo/merchant-studio/scripts/verify-production-copy.mjs',
      'demo/merchant-studio/scripts/verify-production-copy.test.mjs',
      'packages/ai/src/embedding.ts',
      'packages/ai/src/generator.ts',
      'packages/ai/src/image-editor.ts',
      'packages/ai/src/image-facts.ts',
      'packages/ai/src/image-generator.ts',
      'packages/ai/src/image-generator.test.ts',
      'packages/ai/src/relay-usage.ts',
      'packages/ai/src/relay-usage.test.ts',
      'packages/ai/src/video-generator.ts',
      'infra/scripts/verify-ecs-ops-auth-mode.sh',
      'infra/scripts/build-ecs-release-images.sh',
      'infra/scripts/deploy-preflight-ecs.sh',
      'infra/scripts/deploy-preflight.sh',
      'apps/plugin/scripts/upgrade-installed-plugin.mjs',
      'apps/plugin/scripts/upgrade-installed-plugin.test.ts',
      '.codex-marketplace/plugins/merchant-marketing/scripts/upgrade-installed-plugin.mjs',
      '.codex-marketplace/plugins/merchant-marketing/scripts/upgrade-installed-plugin.test.ts',
      'packages/persistence/src/migration.ts',
      'packages/persistence/src/migration-245.test.ts',
      'packages/persistence/src/migrations/245_local_plugin_authorized_timestamp.sql',
      'scripts/model-relay-canary.ts',
      'scripts/release-manifest.ts',
      'scripts/scanner-callback-canary.mjs',
      'scripts/scanner-callback-canary-evidence.ts',
      'tests/ecs-compose-deploy-runner.test.ts',
      'tests/ecs-release-images-build.test.ts',
      'tests/model-relay-contract.test.ts',
      'tests/production-evidence-gate.ts',
      'tests/release-manifest-gate.ts',
      '.github/workflows/ci.yml',
      'docs/runbooks/ecs-candidate-safe-sync.md',
      'docs/runbooks/ecs-verified-compose-deploy.md',
      'docs/runbooks/scanner-callback-canary.md',
      'AGENTS.md',
      'infra/scripts/prepare-ecs-candidate-bundle.sh',
      'tests/ecs-candidate-bundle-contract.test.ts',
      'tests/test-entrypoint-coverage.ts',
      'tests/scanner-callback-canary-evidence.test.ts',
      'docs/chatgpt-host-canary-runbook.md',
      'docs/runbooks/chatgpt-candidate-host-route.md',
      'infra/scripts/chatgpt-candidate-fetch-route.d.mts',
      'infra/scripts/chatgpt-candidate-fetch-route.mjs',
      'scripts/collect-codex-app-host-evidence.mjs',
      'tests/chatgpt-candidate-fetch-route.test.ts',
      'tests/codex-app-host-evidence-gate.test.ts',
      'tests/codex-app-host-evidence-gate.ts',
      'tests/operations-scripts.test.ts',
      'apps/worker/src/scanner-heartbeat.ts',
      'apps/worker/src/scanner-container-healthcheck.ts',
      'apps/worker/src/scanner-container-healthcheck.test.ts',
      'infra/local/docker-compose.yml',
      'tests/local-compose-ops-ui.test.ts',
      'demo/merchant-studio/src/manual-platform-account-discovery.test.ts',
      'infra/scripts/validate-production-config-yaml.rb',
      'infra/protected/ecs-bridge-b-journal-store.mjs',
      'infra/protected/ecs-bridge-b-journal-store.d.mts',
      'infra/protected/ecs-bridge-b-transition.mjs',
      'infra/protected/ecs-bridge-b-transition.d.mts',
      'packages/workers/src/scanner-heartbeat.ts',
      'packages/workers/src/scanner-heartbeat.test.ts',
      'tests/ecs-compose-rollback.test.ts',
      'tests/mcp-integration-mode-release-gate.test.ts',
      'tests/ecs-bridge-b-transition.test.ts',
      'tests/run-protected-nonce-consumer-isolated.sh',
      'tests/run-ecs-bridge-b-host-cli.sh',
      'tests/fixtures/ecs-bridge-b-host-cli/curl.mjs',
      'tests/fixtures/ecs-bridge-b-host-cli/docker.mjs',
      'tests/fixtures/ecs-bridge-b-host-cli/nonce-consumer.mjs',
      'tests/fixtures/ecs-bridge-b-host-cli/psql.mjs',
      'tests/fixtures/ecs-bridge-b-host-cli/run.mjs',
      'tests/fixtures/ecs-bridge-b-host-cli/setup.mjs',
    ]) expect(manifest, `${path} must be compared with the remote checkout`).toContain(path)

    const entries = manifest.slice(manifest.indexOf("<<'EOF'\n") + "<<'EOF'\n".length).split('\n').filter(Boolean)
    expect(new Set(entries).size, 'manifest paths must not be duplicated').toBe(entries.length)
    const dynamicInputs = [
      'apps/ops-console/package.json',
      'apps/ops-console/src/App.tsx',
      'infra/docker/ui.Dockerfile',
      'infra/docker/ops-console.Dockerfile',
      'infra/nginx/merchant-studio.conf',
      'infra/nginx/merchant-studio-entrypoint.sh',
      'infra/nginx/ops-console.conf',
      'packages/persistence/src/migrations/245_local_plugin_authorized_timestamp.sql',
    ]
    const dynamicLoopStart = script.indexOf('# The migration registry, both UI images, and their reverse-proxy configs are')
    const dynamicLoopEnd = script.indexOf('\nwhile IFS= read -r path; do', dynamicLoopStart)
    expect(dynamicLoopStart).toBeGreaterThanOrEqual(0)
    expect(dynamicLoopEnd).toBeGreaterThan(dynamicLoopStart)
    const dynamicLoop = script.slice(dynamicLoopStart, dynamicLoopEnd)
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'candidate-manifest-loop-'))
    const fixtureRepo = join(fixtureRoot, 'repo')
    const fixtureManifest = join(fixtureRoot, 'manifest.txt')
    try {
      mkdirSync(fixtureRepo)
      execFileSync('git', ['init', '--quiet', fixtureRepo])
      for (const path of dynamicInputs) {
        const filePath = join(fixtureRepo, path)
        mkdirSync(join(filePath, '..'), { recursive: true })
        writeFileSync(filePath, `fixture: ${path}\n`)
      }
      execFileSync('git', ['-C', fixtureRepo, 'add', '--all'])
      writeFileSync(fixtureManifest, 'apps/ops-console/package.json\ncurated/release-input.txt\n')
      execFileSync('sh', ['-c', dynamicLoop], {
        cwd: fixtureRepo,
        env: { ...process.env, root: fixtureRepo, manifest: fixtureManifest },
      })
      const generatedEntries = readFileSync(fixtureManifest, 'utf8').trim().split('\n')
      expect(generatedEntries).toContain('curated/release-input.txt')
      for (const path of dynamicInputs) expect(generatedEntries, `${path} must be present in the actual generated review manifest`).toContain(path)
      expect(generatedEntries.filter(path => path === 'apps/ops-console/package.json')).toHaveLength(1)
      expect(new Set(generatedEntries).size, 'actual generated review manifest must not contain duplicates').toBe(generatedEntries.length)
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('keeps host deployment entrypoints executable while verifier modules remain data', () => {
    for (const path of [
      'infra/scripts/render-ecs-production-compose.sh',
      'infra/scripts/stage-verified-ecs-release.sh',
      'infra/scripts/check-ecs-storage-budget.sh',
      'infra/scripts/deploy-verified-ecs-compose.sh',
      'infra/scripts/rollback-ecs-compose.sh',
      'infra/scripts/invoke-ecs-automatic-rollback.sh',
      'tests/run-ecs-bridge-b-host-cli.sh',
      'infra/protected/attest-release-evidence-bundle.mjs',
    ]) expect(statSync(path).mode & 0o111, `${path} must be executable in the release tree`).not.toBe(0)
    expect(statSync('tests/release-evidence-bundle-gate.ts').mode & 0o111).toBe(0)
  })

  it('documents Bridge B as a gated runtime-only transition and includes its shared nonce trust source', () => {
    const runbook = readFileSync('docs/runbooks/ecs-bridge-b-transition.md', 'utf8')
    const nonceRunbook = readFileSync('docs/runbooks/ecs-production-nonce-consumer.md', 'utf8')
    const controller = readFileSync('infra/protected/ecs-bridge-b-transition.mjs', 'utf8')
    const nonceConsumer = readFileSync('infra/protected/consume-production-evidence-nonce.py', 'utf8')

    expect(runbook).toContain('## Preconditions and installation')
    expect(runbook).toContain('## Capture baseline')
    expect(runbook).toContain('## Install Bridge B')
    expect(runbook).toContain('## Recover')
    expect(runbook).toContain('exec 9>>/var/lib/merchant-release-security/production-deploy.lock')
    expect(runbook).toContain('flock -n 9')
    expect(runbook).toContain('Bridge B does not override any gate')
    expect(runbook).toContain('NO-GO')
    expect(runbook).toContain('migration-242')
    expect(runbook).toContain('never')
    expect(controller).toContain("'/usr/local/libexec/merchant/consume-production-evidence-nonce'")
    expect(controller).toContain('migrationCommandAllowed: false')
    expect(nonceConsumer).toContain('BEGIN IMMEDIATE')
    expect(nonceConsumer).toContain('production-nonces.sqlite3')
    expect(nonceRunbook).toContain('production-evidence-nonce-consumer-sha256')
  })

  it('documents a locked, digest-checked atomic nonce-consumer upgrade without ledger replacement', () => {
    const runbook = readFileSync('docs/runbooks/ecs-production-nonce-consumer.md', 'utf8')
    const upgradeStart = runbook.indexOf('### 已有环境升级（保护旧 consumer 和 ledger）')
    const upgrade = runbook.slice(upgradeStart)
    const codeStart = upgrade.indexOf('```sh\n') + '```sh\n'.length
    const code = upgrade.slice(codeStart, upgrade.indexOf('\n```', codeStart))

    expect(upgradeStart).toBeGreaterThanOrEqual(0)
    expect(runbook).toContain('### 首次安装（只有目标不存在时）')
    expect(runbook).toContain('test ! -e /var/lib/merchant-release-security/production-nonces.sqlite3')
    expect(upgrade).toContain('EXPECTED_OLD_NONCE_CONSUMER_SHA256')
    expect(upgrade).toContain('REVIEWED_NEW_NONCE_CONSUMER_SHA256')
    expect(upgrade).toContain('不得打开、迁移、复制覆盖、删除或重建 `production-nonces.sqlite3`')
    expect(upgrade).toContain('旧 ledger 中已有 `consumed_nonces` 记录但尚无 `nonce_owners` 记录时，Bridge B 必须视为来源未知并拒绝使用')
    expect(code).not.toContain('production-nonces.sqlite3')
    expect(code).toContain('exec 9>>"$lock"')
    expect(code).toContain('flock -n 9')
    expect(code).toContain('test "$old_actual" = "$EXPECTED_OLD_NONCE_CONSUMER_SHA256"')
    expect(code).toContain('test "$old_trusted" = "$EXPECTED_OLD_NONCE_CONSUMER_SHA256"')
    expect(code).toContain('install -o root -g root -m 0400 "$consumer" "$backup"')
    expect(code).toContain('mktemp /usr/local/libexec/merchant/.nonce-consumer.XXXXXX')
    expect(code).toContain('mktemp "$trust_dir/.nonce-consumer-digest.XXXXXX"')
    expect(code.indexOf('mv -f -- "$consumer_tmp" "$consumer"')).toBeLessThan(code.indexOf('mv -f -- "$digest_tmp" "$digest_file"'))
    expect(code).toContain('test "$(sha256sum "$consumer" | awk \'{print $1}\')" = "$(cat "$digest_file")"')
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

  it('refuses to overwrite an existing candidate directory before remote access', () => {
    const root = mkdtempSync(join(tmpdir(), 'ecs-candidate-existing-'))
    mkdirSync(join(root, 'infra/scripts'), { recursive: true })
    cpSync(resolve('infra/scripts/prepare-ecs-candidate-bundle.sh'), join(root, 'infra/scripts/prepare-ecs-candidate-bundle.sh'))
    spawnSync('git', ['init', '-q'], { cwd: root })
    spawnSync('git', ['add', '.'], { cwd: root })
    spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'candidate'], { cwd: root })
    const output = join(root, '..', `${root.split('/').at(-1)}-already-reviewed`)
    mkdirSync(output)
    writeFileSync(join(output, 'review-note.txt'), 'preserve this review\n')

    const result = spawnSync('sh', [join(root, 'infra/scripts/prepare-ecs-candidate-bundle.sh'), output], {
      env: { ...process.env, ECS_CANDIDATE_REMOTE_ALIAS: 'must-not-connect.invalid' },
      encoding: 'utf8',
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('candidate output directory already exists')
    expect(result.stderr).not.toContain('ssh')
    expect(readFileSync(join(output, 'review-note.txt'), 'utf8')).toBe('preserve this review\n')
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
