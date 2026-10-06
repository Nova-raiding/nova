import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateDemoCompose } from '../infra/scripts/render-ecs-demo-candidate.mjs'

const entry = resolve('infra/scripts/render-ecs-demo-candidate.mjs')
const project = 'merchant-demo-b77-check'
const gitSha = 'a'.repeat(40)
let sourceSha = ''
const imageKeys = ['merchant-api', 'merchant-worker', 'merchant-ui', 'merchant-ops-ui', 'payment-gateway', 'pilot-gateway']
const images = Object.fromEntries(imageKeys.map((key, index) => [key, `registry.invalid/merchant/${key}@sha256:${String(index + 1).repeat(64)}`]))

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ecs-demo-candidate-render-')))
  const source = join(root, 'source')
  const migrations = join(source, 'packages/persistence/src/migrations')
  const scripts = join(source, 'infra/scripts')
  const local = join(source, 'infra/local')
  const output = join(root, 'protected-output')
  mkdirSync(migrations, { recursive: true, mode: 0o700 })
  mkdirSync(scripts, { recursive: true, mode: 0o700 })
  mkdirSync(local, { recursive: true, mode: 0o700 })
  mkdirSync(output, { mode: 0o700 })
  writeFileSync(join(migrations, '001_candidate.sql'), 'SELECT 1;\n', { mode: 0o600 })
  writeFileSync(join(scripts, 'apply-migrations.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o600 })
  writeFileSync(join(local, 'ensure-app-role.sql'), 'SELECT 1;\n', { mode: 0o600 })
  writeFileSync(join(scripts, 'verify-runtime-db-role.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o600 })
  writeFileSync(join(scripts, 'provision-isolated-candidate-db-roles.sh'), readFileSync('infra/scripts/provision-isolated-candidate-db-roles.sh'), { mode: 0o600 })
  // Git archives include the migrations directory entry as well as SQL files.
  spawnSync('tar', ['-cf', join(source, '.candidate-source.tar'), '-C', source, 'packages/persistence/src/migrations', 'infra/scripts/apply-migrations.sh', 'infra/local/ensure-app-role.sql', 'infra/scripts/verify-runtime-db-role.sh', 'infra/scripts/provision-isolated-candidate-db-roles.sh'])
  sourceSha = `sha256:${createHash('sha256').update(readFileSync(join(source, '.candidate-source.tar'))).digest('hex')}`
  const identity = join(source, '.candidate-identity')
  const eightImages = {
    ...images,
    'postgres-migration': `registry.invalid/postgres:17-alpine@sha256:${'c'.repeat(64)}`,
    clamav: `registry.invalid/merchant/clamav@sha256:${'d'.repeat(64)}`,
  }
  const imageMetadata = Object.fromEntries(Object.entries(eightImages).map(([artifact, reference]) => [artifact, {
    reference,
    digest: reference.slice(reference.lastIndexOf('@') + 1),
    labels: {
      'org.opencontainers.image.revision': gitSha,
      'com.storenova.release.id': 'release-b77b551a-review',
      'com.storenova.release.source_sha256': sourceSha,
    },
  }]))
  const releaseImages = join(root, 'release-images.json')
  const eightImageSet = join(root, 'eight-image-set.json')
  const rootEnv = join(root, 'relay.env')
  writeFileSync(releaseImages, `${JSON.stringify({
    schema_version: 1, release_id: 'release-b77b551a-review', release_git_sha: gitSha, source_sha256: sourceSha,
    image_digests: Object.fromEntries(Object.entries(images).map(([key, ref]) => [key, ref.slice(ref.lastIndexOf('@') + 1)])), image_references: images, image_metadata: Object.fromEntries(Object.entries(imageMetadata).filter(([key]) => imageKeys.includes(key))),
  })}\n`, { mode: 0o600 })
  writeFileSync(eightImageSet, `${JSON.stringify({
    schema_version: 1, release_id: 'release-b77b551a-review', release_git_sha: gitSha, source_sha256: sourceSha,
    image_digests: Object.fromEntries(Object.entries(eightImages).map(([key, ref]) => [key, ref.slice(ref.lastIndexOf('@') + 1)])), image_references: eightImages,
    image_metadata: imageMetadata,
  })}\n`, { mode: 0o600 })
  writeFileSync(rootEnv, 'MODEL_RELAY_API_KEY=relay-private-test-key\n', { mode: 0o600 })
  writeFileSync(identity, `release_id=release-b77b551a-review\ngit_sha=${gitSha}\nsource_sha256=${sourceSha}\n`, { mode: 0o600 })
  const args = ['--identity', identity, '--release-images', releaseImages, '--eight-image-set', eightImageSet, '--root-env', rootEnv, '--source-root', source,
    '--output-dir', output, '--project', project,
    '--redis-image', `registry.invalid/redis:7-alpine@sha256:${'e'.repeat(64)}`]
  const run = (extra: string[] = [], target = output) => {
    const actual = [...args]
    actual[actual.indexOf('--output-dir') + 1] = target
    return spawnSync(process.execPath, [entry, ...actual, ...extra], {
      encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', VITEST: 'true', DEMO_CANDIDATE_TEST_UNPROTECTED_FILES: 'true' },
    })
  }
  return { root, source, output, identity, releaseImages, eightImageSet, rootEnv, args, run }
}

describe('protected isolated ECS demo candidate renderer', () => {
  it('injects explicit commercial runtime env with a read-only existing directory without widening the relay secret file', () => {
    const value = fixture()
    const commercialDir = join(value.root,'commercial-evidence')
    mkdirSync(commercialDir,{mode:0o700})
    const envPath=join(value.root,'commercial.env')
    writeFileSync(envPath,`COMMERCIAL_RUNTIME_HOST_DIR=${commercialDir}\nCOMMERCIAL_RUNTIME_EVIDENCE_PATH=/run/merchant-commercial/lease.json\nCOMMERCIAL_RUNTIME_FLEET_OBSERVATION_PATH=/run/merchant-commercial/fleet.json\n`,{mode:0o600})
    const result=value.run(['--commercial-runtime-env',envPath])
    expect(result.status,result.stderr).toBe(0)
    const compose=JSON.parse(readFileSync(join(value.output,'candidate.compose.json'),'utf8'))
    expect(compose.services.api.environment.COMMERCIAL_RUNTIME_EVIDENCE_PATH).toBe('/run/merchant-commercial/lease.json')
    expect(compose.services.api.volumes.at(-1)).toMatchObject({type:'bind',target:'/run/merchant-commercial',read_only:true,bind:{create_host_path:false}})
  })
  it('renders only four private services, fresh scoped state, pinned six-image identity, and disabled Qwen1024 configuration', () => {
    const value = fixture()
    const result = value.run()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).not.toContain('relay-private-test-key')
    const composeText = readFileSync(join(value.output, 'candidate.compose.json'), 'utf8')
    const compose = JSON.parse(composeText)
    expect(Object.keys(compose.services).sort()).toEqual(['api', 'migrate', 'postgres', 'redis'])
    expect(compose.services.api.environment).toMatchObject({
      RELEASE_ID: 'release-b77b551a-review', RELEASE_GIT_SHA: gitSha, NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://candidate.yxsona.com', EMBEDDING_VERSION: 'v1',
      KNOWLEDGE_VECTOR_INDEX_ENABLED: 'false', EMBEDDING_MODEL: 'qwen3.7-text-embedding-flash', EMBEDDING_DIMENSIONS: '1024',
      PLUGIN_WRITE_ENABLED: 'false', ASSET_STORAGE_PREFIX: 'demo-candidate/release-b77b551a-review',
      MCP_AUTHZ_MODE: 'enforce', MCP_AUTHZ_ENFORCE_DOMAINS: '', AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED: 'true',
    })
    expect(compose.services.api.pull_policy).toBe('never')
    expect(compose.services.migrate.depends_on).toEqual({ postgres: { condition: 'service_healthy' } })
    expect(compose.services.api.depends_on).toEqual({
      migrate: { condition: 'service_completed_successfully' },
      postgres: { condition: 'service_healthy' },
      redis: { condition: 'service_healthy' },
    })
    expect(compose.services.api.environment.MODEL_RELAY_API_KEY).toBeUndefined()
    expect(compose.services.api.env_file).toEqual([{ path: join(value.output, 'candidate.env'), required: true }])
    expect(compose.services.api.healthcheck.test).toEqual(['CMD-SHELL', 'wget -qO- http://127.0.0.1:8787/healthz >/dev/null || exit 1'])
    expect(compose.services.api.environment.RELEASE_IMAGE_SET_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(compose.services.api.environment.RELEASE_MANIFEST_SHA256).toBe(createHash('sha256').update(readFileSync(join(value.output, 'candidate-manifest.json'))).digest('hex'))
    expect(JSON.parse(readFileSync(join(value.output, 'candidate-manifest.json'), 'utf8')).renderer_sha256).toMatch(/^[0-9a-f]{64}$/u)
    const capsuleText = readFileSync(join(value.output, 'candidate-review-capsule.json'), 'utf8')
    const capsule = JSON.parse(capsuleText)
    expect(capsule).toMatchObject({
      schema_version: '1', kind: 'ecs-compose-review-capsule', status: 'review_only',
      deployable: false, production_go: false, release_id: 'release-b77b551a-review', git_sha: gitSha,
      image_set_digest: compose.services.api.environment.RELEASE_IMAGE_SET_DIGEST, compose_project: project,
      migration_target: 1, public_ports: [],
      rollback: { strategy: 'forward_only', schema_downgrade: false, preserve_volumes: true, production_cutover_authorized: false },
    })
    expect(capsule.reproducible_binding).toMatchObject({
      source_sha256: sourceSha, renderer_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u), image_set_digest: capsule.image_set_digest, migration_target: 1,
    })
    expect(capsule.artifact_digests.candidate_manifest_sha256).toBe(createHash('sha256').update(readFileSync(join(value.output, 'candidate-manifest.json'))).digest('hex'))
    expect(capsule.artifact_digests.candidate_compose_sha256).toBe(createHash('sha256').update(composeText).digest('hex'))
    expect(capsuleText).not.toContain('relay-private-test-key')
    expect(capsuleText).not.toMatch(/MODEL_RELAY_API_KEY|POSTGRES_PASSWORD|postgres:\/\//u)
    for (const service of Object.values(compose.services) as any[]) expect(service.ports ?? []).toEqual([])
    expect(Object.values(compose.volumes).map((entry: any) => entry.name).sort()).toEqual([
      `${project}_postgres_data`, `${project}_redis_data`,
    ])
    expect(compose.networks.default).toMatchObject({ name: `${project}_private`, external: false })
    expect(compose.services.migrate.image).toContain('postgres:17-alpine@sha256:')
    expect(compose.services.migrate.environment.PGHOST).toBe('postgres')
    expect(compose.services.migrate.environment.DATABASE_URL).toBe(compose.services.api.environment.DATABASE_URL)
    expect(compose.services.migrate.environment.OPS_DATABASE_URL).toBe(compose.services.api.environment.OPS_DATABASE_URL)
    expect(compose.services.migrate.volumes).toEqual([
      { type: 'bind', source: join(value.source, 'packages/persistence/src/migrations'), target: '/migrations', read_only: true },
      { type: 'bind', source: join(value.source, 'infra/scripts/apply-migrations.sh'), target: '/ops/apply-migrations.sh', read_only: true },
      { type: 'bind', source: join(value.source, 'infra/local/ensure-app-role.sql'), target: '/ops/ensure-app-role.sql', read_only: true },
      { type: 'bind', source: join(value.source, 'infra/scripts/verify-runtime-db-role.sh'), target: '/ops/verify-runtime-db-role.sh', read_only: true },
      { type: 'bind', source: join(value.source, 'infra/scripts/provision-isolated-candidate-db-roles.sh'), target: '/ops/provision-isolated-candidate-db-roles.sh', read_only: true },
    ])
    const migrateCommand = compose.services.migrate.entrypoint[2]
    expect(migrateCommand.indexOf('/ops/provision-isolated-candidate-db-roles.sh')).toBeLessThan(migrateCommand.indexOf('/ops/ensure-app-role.sql'))
    expect(migrateCommand.indexOf('/ops/ensure-app-role.sql')).toBeLessThan(migrateCommand.indexOf('/ops/apply-migrations.sh'))
    expect(migrateCommand).toContain('verify-runtime-db-role.sh')
    const roleUrls = ['DATABASE_URL', 'OPS_DATABASE_URL', 'ALERT_RECEIVER_DATABASE_URL'].map(key => new URL(compose.services.api.environment[key]))
    expect(roleUrls.map(url => url.username).sort()).toEqual(['merchant_alert_receiver', 'merchant_app', 'merchant_ops'])
    expect(new Set(roleUrls.map(url => url.password)).size).toBe(3)
    expect(roleUrls.every(url => url.hostname === 'postgres' && /^[0-9a-f]{48}$/u.test(url.password))).toBe(true)
    expect(readFileSync(join(value.output, 'candidate.env'), 'utf8')).toBe('MODEL_RELAY_API_KEY=relay-private-test-key\n')
    expect(composeText).not.toContain('relay-private-test-key')
    for (const name of ['candidate.env', 'candidate.compose.json', 'candidate-identity.txt', 'candidate-manifest.json', 'candidate-review-capsule.json']) {
      expect(lstatSync(join(value.output, name)).mode & 0o777).toBe(0o600)
    }
    expect(validateDemoCompose(compose, project)).toBe(true)
    const stagedAuthorization = structuredClone(compose)
    stagedAuthorization.services.api.environment.MCP_AUTHZ_MODE = 'staged'
    expect(() => validateDemoCompose(stagedAuthorization, project)).toThrow(/enforce all MCP authorization domains/u)
    const narrowedAuthorization = structuredClone(compose)
    narrowedAuthorization.services.api.environment.MCP_AUTHZ_ENFORCE_DOMAINS = 'support'
    expect(() => validateDemoCompose(narrowedAuthorization, project)).toThrow(/enforce all MCP authorization domains/u)
    const composeCheck = spawnSync('docker', ['compose', '--project-name', project, '--env-file', join(value.output, 'candidate.env'), '-f', join(value.output, 'candidate.compose.json'), 'config', '--quiet'], { encoding: 'utf8' })
    expect(composeCheck.status, composeCheck.stderr).toBe(0)
  })

  it('renders an explicit staging runtime without changing isolation or authorization controls', () => {
    const value = fixture()
    const result = value.run(['--runtime-environment', 'staging'])
    expect(result.status, result.stderr).toBe(0)
    const compose = JSON.parse(readFileSync(join(value.output, 'candidate.compose.json'), 'utf8'))
    expect(compose['x-candidate-runtime-environment']).toBe('staging')
    expect(compose.services.api.environment).toMatchObject({
      NODE_ENV: 'staging', PLUGIN_WRITE_ENABLED: 'false',
      MCP_AUTHZ_MODE: 'enforce', MCP_AUTHZ_ENFORCE_DOMAINS: '', AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED: 'true',
      AI_MODEL: 'glm-4.7-flash', IMAGE_MODEL: 'qwen-image-2.0', IMAGE_EDIT_MODEL: 'qwen-image-2.0',
      OCR_MODEL: 'agnes-2.5-flash', VIDEO_MODEL: 'happyhorse-1.1-t2v', MODEL_RELAY_COST_EVIDENCE: 'true',
    })
    expect(compose.services.api.ports ?? []).toEqual([])
    expect(compose.networks.default).toMatchObject({ name: `${project}_private`, external: false })
    expect(JSON.parse(readFileSync(join(value.output, 'candidate-manifest.json'), 'utf8')).runtime_environment).toBe('staging')
    expect(JSON.parse(readFileSync(join(value.output, 'candidate-review-capsule.json'), 'utf8')).runtime_environment).toBe('staging')
  })

  it('rejects an unsupported runtime environment before writing candidate artifacts', () => {
    const value = fixture()
    const result = value.run(['--runtime-environment', 'development'])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('--runtime-environment must be production or staging')
  })

  it('rejects ports, shared volumes/networks, and writable absolute host mounts', () => {
    const value = fixture()
    expect(value.run().status).toBe(0)
    const compose = JSON.parse(readFileSync(join(value.output, 'candidate.compose.json'), 'utf8'))
    const withPorts = structuredClone(compose)
    withPorts.services.api.ports = [{ target: 8787, published: '80' }]
    expect(() => validateDemoCompose(withPorts, project)).toThrow(/host ports/u)
    const sharedVolume = structuredClone(compose)
    sharedVolume.volumes.postgres_data.name = 'merchant-postgres'
    expect(() => validateDemoCompose(sharedVolume, project)).toThrow(/project-scoped/u)
    const sharedNetwork = structuredClone(compose)
    sharedNetwork.networks.default = { name: 'merchant-production_default', external: true }
    expect(() => validateDemoCompose(sharedNetwork, project)).toThrow(/project-scoped private network/u)
    const writableHostBind = structuredClone(compose)
    writableHostBind.services.migrate.volumes[0].read_only = false
    expect(() => validateDemoCompose(writableHostBind, project)).toThrow(/writable host bind/u)
    const readinessAsLiveness = structuredClone(compose)
    readinessAsLiveness.services.api.healthcheck.test[1] = 'wget -qO- http://127.0.0.1:8787/readyz || exit 1'
    expect(() => validateDemoCompose(readinessAsLiveness, project)).toThrow(/healthcheck must measure liveness/u)
    const pullsByDefault = structuredClone(compose)
    delete pullsByDefault.services.api.pull_policy
    expect(() => validateDemoCompose(pullsByDefault, project)).toThrow(/pull_policy=never/u)
    const pullsExplicitly = structuredClone(compose)
    pullsExplicitly.services.api.pull_policy = 'always'
    expect(() => validateDemoCompose(pullsExplicitly, project)).toThrow(/pull_policy=never/u)
  })

  it('requires the isolated role provisioner to match the candidate archive byte for byte', () => {
    const value = fixture()
    writeFileSync(join(value.source, 'infra/scripts/provision-isolated-candidate-db-roles.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o600 })
    const result = value.run()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('mounted migration input differs from the candidate source archive')
  })

  it('provisions exactly the three generated roles through psql stdin without credential output or argv', () => {
    const value = fixture()
    const bin = join(value.root, 'bin')
    mkdirSync(bin, { mode: 0o700 })
    const argvCapture = join(value.root, 'psql-argv')
    const sqlCapture = join(value.root, 'psql-stdin')
    writeFileSync(join(bin, 'psql'), '#!/bin/sh\nprintf "%s" "$*" > "$PSQL_ARGV_CAPTURE"\ncat > "$PSQL_STDIN_CAPTURE"\necho "secret-bearing SQL error" >&2\nexit "${PSQL_EXIT_CODE:-0}"\n', { mode: 0o700 })
    const passwords = ['a'.repeat(48), 'b'.repeat(48), 'c'.repeat(48)]
    const environment = {
      ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`,
      DATABASE_URL: `postgres://merchant_app:${passwords[0]}@postgres:5432/merchant`,
      OPS_DATABASE_URL: `postgres://merchant_ops:${passwords[1]}@postgres:5432/merchant`,
      ALERT_RECEIVER_DATABASE_URL: `postgres://merchant_alert_receiver:${passwords[2]}@postgres:5432/merchant`,
      PSQL_ARGV_CAPTURE: argvCapture, PSQL_STDIN_CAPTURE: sqlCapture,
    }
    const script = resolve('infra/scripts/provision-isolated-candidate-db-roles.sh')
    const good = spawnSync('/bin/sh', [script], { encoding: 'utf8', env: environment })
    expect(good.status, good.stderr).toBe(0)
    expect(good.stdout).toBe('')
    expect(good.stderr).toBe('')
    const args = readFileSync(argvCapture, 'utf8')
    const sql = readFileSync(sqlCapture, 'utf8')
    expect(args).toBe('-X -q -v ON_ERROR_STOP=1')
    for (const password of passwords) {
      expect(args).not.toContain(password)
      expect(sql).toContain(password)
    }
    expect(sql).toContain('NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS')
    expect(sql).toContain('COMMIT;')

    const failed = spawnSync('/bin/sh', [script], { encoding: 'utf8', env: { ...environment, PSQL_EXIT_CODE: '7' } })
    expect(failed.status).not.toBe(0)
    expect(failed.stdout).toBe('')
    expect(failed.stderr).toBe('isolated candidate role provisioning failed\n')
    const invalid = spawnSync('/bin/sh', [script], { encoding: 'utf8', env: { ...environment, OPS_DATABASE_URL: `postgres://merchant_ops:${passwords[0]}@postgres:5432/merchant` } })
    expect(invalid.status).not.toBe(0)
    expect(invalid.stderr).toBe('isolated candidate role credentials are invalid\n')
  })

  it('rejects a mismatched identity, incomplete image set, unapproved model, and non-dedicated root env', () => {
    const mismatch = fixture()
    const manifest = JSON.parse(readFileSync(mismatch.releaseImages, 'utf8'))
    manifest.release_git_sha = 'f'.repeat(40)
    writeFileSync(mismatch.releaseImages, JSON.stringify(manifest), { mode: 0o600 })
    expect(mismatch.run().stderr).toContain('does not match the candidate identity')

    const incomplete = fixture()
    const partial = JSON.parse(readFileSync(incomplete.releaseImages, 'utf8'))
    delete partial.image_references['pilot-gateway']
    delete partial.image_digests['pilot-gateway']
    writeFileSync(incomplete.releaseImages, JSON.stringify(partial), { mode: 0o600 })
    expect(incomplete.run().stderr).toContain('exactly the approved six images')

    const model = fixture()
    expect(model.run(['--embedding-model', 'not-qwen']).stderr).toContain('not an approved Qwen model')

    const env = fixture()
    writeFileSync(env.rootEnv, 'MODEL_RELAY_API_KEY=relay-private-test-key\nDATABASE_URL=forbidden\n', { mode: 0o600 })
    const rejected = env.run()
    expect(rejected.stderr).toContain('only one MODEL_RELAY_API_KEY assignment')
    expect(rejected.stderr).not.toContain('relay-private-test-key')
  })

  it('uses O_EXCL and refuses to overwrite a previous candidate', () => {
    const value = fixture()
    expect(value.run().status).toBe(0)
    const composePath = join(value.output, 'candidate.compose.json')
    const before = readFileSync(composePath)
    const retry = value.run()
    expect(retry.status).not.toBe(0)
    expect(retry.stderr).toContain('candidate output already exists')
    expect(readFileSync(composePath)).toEqual(before)
  })

  it('renders a private merchant browser candidate with pinned UI and migration target', () => {
    const value = fixture()
    const result = value.run(['--merchant-ui', 'enabled'])
    expect(result.status, result.stderr).toBe(0)
    const compose = JSON.parse(readFileSync(join(value.output, 'candidate.compose.json'), 'utf8'))
    const manifest = JSON.parse(readFileSync(join(value.output, 'candidate-manifest.json'), 'utf8'))
    expect(Object.keys(compose.services).sort()).toEqual(['api', 'migrate', 'postgres', 'redis', 'ui'])
    expect(manifest.deployment_scope).toBe('isolated_merchant_browser_candidate')
    expect(manifest.migration_target).toBe(1)
    expect(compose.services.ui.image).toBe(images['merchant-ui'])
    expect(compose.services.ui.ports).toBeUndefined()
    expect(compose.services.api.networks.default.aliases).toEqual(['merchant-api'])
    expect(validateDemoCompose(compose, project)).toBe(true)
    const changed = structuredClone(compose)
    changed.services.ui.ports = [{ target: 8080, published: '18443' }]
    expect(() => validateDemoCompose(changed, project)).toThrow(/host ports/u)
  })
})
