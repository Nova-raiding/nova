import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const path = 'infra/scripts/deploy-verified-ecs-compose.sh'
const source = () => readFileSync(path, 'utf8')

describe('verified ECS Compose deployment runner', () => {
  it('captures an external gateway before nonce consumption and recovers it before unlocking for business rollback', () => {
    const script = source()
    expect(script.indexOf('external_gateway_action snapshot')).toBeLessThan(script.indexOf('consume-production-evidence-nonce.sh'))
    expect(script.indexOf('external_gateway_action stop')).toBeLessThan(script.indexOf('up -d --no-build --pull never --remove-orphans'))
    expect(script.indexOf('restore_external_gateway ||')).toBeLessThan(script.indexOf('flock -u 9'))
    expect(script).toContain('check-ports --candidate-project "$project"')
    expect(script).toContain('rollback Compose without public 80/443 bindings')
  })

  it.each([0, 23])('does not restore the external gateway after candidate cleanup exit %s unless cleanup succeeded', exitCode => {
    const script = source()
    const fn = script.slice(script.indexOf('restore_external_gateway() {'), script.indexOf('\nrollback_on_failure() {'))
    const directory = mkdtempSync(join(tmpdir(), 'gateway-trap-'))
    const marker = join(directory, 'restored')
    const node = join(directory, 'node')
    writeFileSync(node, `#!/bin/sh\nexit ${exitCode}\n`); chmodSync(node, 0o700)
    const result = spawnSync('sh', ['-c', `set -eu\nproject=candidate\nRELEASE_ID=release-test\ncandidate_gateway_image=fixture\nexternal_gateway_action() { touch "$MARKER"; }\n${fn}\nif restore_external_gateway; then exit 0; else exit $?; fi`], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, MARKER: marker }, encoding: 'utf8',
    })
    expect(result.status).toBe(exitCode === 0 ? 0 : 1)
    expect(existsSync(marker)).toBe(exitCode === 0)
  })
  it('is valid shell and requires an explicit operator boundary', () => {
    expect(execFileSync('sh', ['-n', path], { encoding: 'utf8' })).toBe('')
    const script = source()
    expect(script).toContain('CONFIRM_ECS_DEPLOY=YES')
    expect(script).toContain('[ "$CONFIRM_ECS_DEPLOY" = YES ]')
    expect(script).toContain('ECS_ROLLBACK_ENTRYPOINT')
    expect(script).toContain('ECS_DEPLOY_STATE_DIR must be absolute')
    expect(script).toContain('ECS_DEPLOY_LOCK_PATH must be canonical')
    expect(script).toContain('flock -n 9')
    expect(script).toContain('const safeBase=url=>')
    expect(script).toContain('app.origin!==approved.origin')
    expect(script).toContain('app.origin+prefix')
    expect(script).toContain('PRODUCTION_API_BASE_URL must be a canonical HTTPS path under PRODUCTION_APPROVED_ORIGIN')
  })

  it('binds the committed candidate before consuming the nonce or mutating Compose', () => {
    const script = source()
    const preflight = script.indexOf('deploy-preflight-ecs.sh')
    const consume = script.indexOf('consume-production-evidence-nonce.sh')
    const localImages = script.indexOf('config --images')
    const migration = script.indexOf('run --rm --no-deps --pull never migrate')
    const completeMigrationVerification = script.indexOf('MIGRATION_CHAIN_MODE=complete sh "$root/infra/scripts/verify-database-migration-chain.sh"')
    const rollout = script.indexOf('up -d --no-build --pull never --remove-orphans')
    expect(script).toContain('candidate identity Git SHA does not match')
    expect(script).toContain('candidate identity source digest does not match')
    expect(script).toContain('candidate identity release ID does not match requested release')
    expect(script).toContain('staged source member differs from the verified archive')
    expect(script).toContain('staged candidate identity does not match the deployment input')
    expect(script).toContain('git get-tar-commit-id < "$root/.candidate-source.tar"')
    expect(script).toContain('rendered Compose source changed after preflight')
    expect(script).toContain('chmod 0400 "$verified_compose" "$verified_config"')
    expect(script.match(/assert_inputs_unchanged/g)?.length).toBeGreaterThanOrEqual(4)
    expect(preflight).toBeGreaterThan(0)
    expect(localImages).toBeGreaterThan(preflight)
    expect(consume).toBeGreaterThan(preflight)
    expect(localImages).toBeLessThan(consume)
    expect(migration).toBeGreaterThan(consume)
    expect(completeMigrationVerification).toBeGreaterThan(migration)
    expect(completeMigrationVerification).toBeLessThan(rollout)
    expect(rollout).toBeGreaterThan(migration)
  })

  it('preflights every immutable image locally and forbids deploy-time pulls', () => {
    const script = source()
    const localImages = script.indexOf('config --images')
    const consume = script.indexOf('consume-production-evidence-nonce.sh')

    expect(script).toContain("docker image inspect --format '{{.Id}}' \"$image\"")
    expect(script).toContain('verified release image is unavailable locally')
    expect(script).toContain('verified release image resolved to an invalid local image ID')
    expect(script).toContain('run --rm --no-deps --pull never migrate')
    expect(script).toContain('up -d --no-build --pull never --remove-orphans')
    expect(localImages).toBeGreaterThan(0)
    expect(localImages).toBeLessThan(consume)
  })

  it('captures rollback state and invokes the protected entrypoint on post-mutation failure', () => {
    const script = source()
    expect(script).toContain('ECS_PREIDENTITY_RECOVERY_ENTRYPOINT')
    expect(script).toContain('capture')
    for (const phase of ['nonce_consumed', 'migration_started', 'migration_complete', 'runtime_cutover_started', 'runtime_identity_verified']) expect(script).toContain(`--phase ${phase}`)
    expect(script).toContain('recover --state "$state_path"')
    expect(script).toContain('Ordinary rollback deliberately retains its complete /releasez current')
    expect(script).toContain('mutation_started=true')
    expect(script).not.toContain('ECS_DEPLOY_STATE_PATH="$state_path"')
    expect(script).toContain('protected rollback entrypoint failed; production remains blocked')
    expect(script).toContain('flock -u 9')
    for (const name of ['ECS_ROLLBACK_PLAN_PATH', 'ECS_ROLLBACK_COMPOSE_PATH', 'ECS_ROLLBACK_ENV_FILE', 'ECS_ROLLBACK_IMAGE_DIGESTS_JSON', 'ECS_ROLLBACK_STATE_PATH']) expect(script).toContain(name)
    expect(script).toContain('invoke-ecs-automatic-rollback.sh')
    const consume = script.indexOf('consume-production-evidence-nonce.sh')
    const noncePhase = script.indexOf('--phase nonce_consumed')
    const migrationPhase = script.indexOf('--phase migration_started')
    const mutation = script.indexOf('mutation_started=true')
    const migration = script.indexOf('run --rm --no-deps --pull never migrate')
    expect(consume).toBeLessThan(noncePhase)
    expect(noncePhase).toBeLessThan(migrationPhase)
    expect(migrationPhase).toBeLessThan(mutation)
    expect(mutation).toBeLessThan(migration)
  })

  it('executes the automatic rollback entrypoint with the complete frozen capsule contract', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ecs-auto-rollback-'))
    const capture = join(directory, 'capture.json')
    const entrypoint = join(directory, 'rollback')
    writeFileSync(entrypoint, `#!/bin/sh\nnode -e 'const fs=require("fs");fs.writeFileSync(process.env.CAPTURE,JSON.stringify({confirm:process.env.CONFIRM_ECS_ROLLBACK,plan:process.env.ECS_ROLLBACK_PLAN_PATH,compose:process.env.ECS_ROLLBACK_COMPOSE_PATH,env:process.env.ECS_ROLLBACK_ENV_FILE,digests:process.env.ECS_ROLLBACK_IMAGE_DIGESTS_JSON,state:process.env.ECS_ROLLBACK_STATE_PATH,lock:process.env.ECS_DEPLOY_LOCK_PATH,project:process.env.ECS_COMPOSE_PROJECT,api:process.env.PRODUCTION_API_BASE_URL,database:process.env.DATABASE_URL,failed:process.env.ECS_FAILED_RELEASE_ID}))'\n`)
    chmodSync(entrypoint, 0o700)
    const expected = {
      confirm: 'YES', plan: '/protected/plan.json', compose: '/protected/compose.yml', env: '/protected/runtime.env',
      digests: '{"api":"sha256:' + 'a'.repeat(64) + '"}', state: '/protected/state.json', lock: '/protected/deploy.lock',
      project: 'merchant-production', api: 'https://production.example.test', database: 'postgres://readonly', failed: 'release-candidate',
    }
    execFileSync('sh', ['infra/scripts/invoke-ecs-automatic-rollback.sh'], { env: {
      ...process.env, CAPTURE: capture, ECS_ROLLBACK_ENTRYPOINT: entrypoint, ECS_ROLLBACK_PLAN_PATH: expected.plan,
      ECS_ROLLBACK_COMPOSE_PATH: expected.compose, ECS_ROLLBACK_ENV_FILE: expected.env, ECS_ROLLBACK_IMAGE_DIGESTS_JSON: expected.digests,
      ECS_ROLLBACK_STATE_PATH: expected.state, ECS_DEPLOY_LOCK_PATH: expected.lock, ECS_COMPOSE_PROJECT: expected.project,
      PRODUCTION_API_BASE_URL: expected.api, DATABASE_URL: expected.database, ECS_FAILED_RELEASE_ID: expected.failed,
    } })
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual(expected)
    // The legacy rollback wrapper never parsed ecs-predeploy-state/1 and still
    // receives only its frozen capsule contract. The new signed journal is not
    // smuggled in as a replacement release identity.
    expect(readFileSync('infra/scripts/invoke-ecs-automatic-rollback.sh', 'utf8')).not.toContain('ECS_DEPLOY_STATE_PATH')
  })

  it('accepts only matching release metadata and then runs the authenticated canary', () => {
    const script = source()
    for (const field of ['release_id', 'release_git_sha', 'manifest_sha256', 'image_set_digest']) {
      expect(script).toContain(field)
    }
    expect(script).toContain('/releasez')
    expect(script).toContain('/v1/products?limit=1&offset=0')
    expect(script).toContain('run-production-canary.sh')
    expect(script).toContain('--require-signed-production')
    expect(script).toContain('PRODUCTION_APPROVED_ORIGIN')
    expect(script).toContain('--wait --wait-timeout')
    expect(script).toContain('ECS_POST_DEPLOY_HEALTH_TIMEOUT_SECONDS')
  })

  it('never destroys Compose services, volumes, database data, or the nonce ledger', () => {
    const script = source()
    expect(script).not.toMatch(/docker compose[^\n]*\bdown\b/u)
    expect(script).not.toContain('down -v')
    expect(script).not.toMatch(/\b(volume|docker volume)\s+(rm|remove|prune)\b/u)
    expect(script).not.toMatch(/\b(dropdb|DROP DATABASE|TRUNCATE)\b/u)
    expect(script).not.toContain('production-nonces.sqlite3')
  })
})
