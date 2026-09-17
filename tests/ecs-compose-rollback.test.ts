import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const path = 'infra/scripts/rollback-ecs-compose.sh'
const source = () => readFileSync(path, 'utf8')

describe('ECS Compose rollback executor', () => {
  it('binds the approved plan to current and target release identities before mutation', () => {
    const script = source()
    const apply = script.indexOf('compose up -d --no-build')

    expect(script).toContain("plan.database?.strategy==='forward_only'")
    expect(script).toContain("plan.database.schema_downgrade===false")
    expect(script).toContain("plan.volumes?.preserve===true")
    expect(script).toContain('target Compose checksum does not match rollback plan')
    expect(script).toContain('target environment checksum does not match rollback capsule')
    expect(script).toContain('target image-digests checksum does not match rollback capsule')
    expect(script).toContain('Compose project does not match rollback capsule')
    expect(script).toContain("plan?.kind==='ecs-compose-rollback-capsule'")
    expect(script).toContain('expires-created<=24*60*60_000')
    expect(script).toContain('current production release identity does not match rollback plan')
    expect(script).toContain('validate-ecs-compose-release.rb')
    expect(script.indexOf('target Compose release contract failed')).toBeLessThan(apply)
    expect(script.indexOf('current production release identity does not match rollback plan')).toBeLessThan(apply)
    expect(script).toContain('rollback image digests must be a non-empty object')
    expect(script).toContain('Object.entries(digestJson).every(([key,value])=>id.test(key)&&digest.test(value))')
  })

  it('freezes reviewed inputs and serializes host mutations before validation', () => {
    const script = source()
    const validation = script.indexOf('target Compose checksum does not match rollback plan')
    const apply = script.indexOf('compose up -d --no-build')

    expect(script).toContain('ECS_DEPLOY_LOCK_PATH')
    expect(script).toContain('flock -n 9')
    expect(script).toContain('another ECS Compose deployment or rollback holds the production mutation lock')
    expect(script).toContain('rollback plan changed while copying')
    expect(script).toContain('rollback Compose changed while copying')
    expect(script).toContain('rollback environment changed while copying')
    expect(script).toContain('ECS_ROLLBACK_COMPOSE_PATH="$snapshot_dir/compose.yml"')
    expect(script).toContain('ECS_ROLLBACK_ENV_FILE="$snapshot_dir/runtime.env"')
    expect(script.indexOf('snapshot_dir=$(mktemp -d')).toBeLessThan(validation)
    expect(script.indexOf('ECS_ROLLBACK_COMPOSE_PATH="$snapshot_dir/compose.yml"')).toBeLessThan(apply)
  })

  it('fails closed when another production mutation owns the host lock', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ecs-rollback-lock-')))
    const bin = join(root, 'bin')
    const state = join(root, 'state')
    mkdirSync(bin)
    mkdirSync(state)
    chmodSync(state, 0o700)
    for (const command of ['docker', 'psql', 'flock']) {
      const executable = join(bin, command)
      writeFileSync(executable, '#!/bin/sh\nexit 99\n')
      chmodSync(executable, 0o700)
    }
    const stat = join(bin, 'stat')
    writeFileSync(stat, '#!/bin/sh\ncase "$2" in %u) id -u;; %a) echo 700;; *) exit 2;; esac\n')
    chmodSync(stat, 0o700)
    const plan = join(root, 'plan.json')
    const compose = join(root, 'compose.yml')
    const env = join(root, 'runtime.env')
    writeFileSync(plan, '{}')
    writeFileSync(compose, 'services: {}\n')
    writeFileSync(env, '')

    const result = spawnSync('sh', [path], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CONFIRM_ECS_ROLLBACK: 'YES',
        ECS_ROLLBACK_PLAN_PATH: plan,
        ECS_ROLLBACK_COMPOSE_PATH: compose,
        ECS_ROLLBACK_ENV_FILE: env,
        ECS_ROLLBACK_IMAGE_DIGESTS_JSON: '{}',
        ECS_ROLLBACK_STATE_PATH: join(state, 'rollback.json'),
        ECS_DEPLOY_LOCK_PATH: join(state, 'production.lock'),
        PRODUCTION_API_BASE_URL: 'https://production.example.test',
        DATABASE_URL: 'postgres://unused',
      },
    })

    expect(result.stderr).toContain('another ECS Compose deployment or rollback holds the production mutation lock')
    expect(result.status).toBe(1)
  })

  it('proves the rollback image can read the forward-only live schema before apply', () => {
    const script = source()
    const metadata = JSON.parse(readFileSync('release-metadata.json', 'utf8')) as { expectedMigrationVersion: number }
    const probe = script.indexOf('compose run --rm --no-deps --entrypoint node')
    const apply = script.indexOf('compose up -d --no-build')

    expect(probe).toBeGreaterThan(0)
    expect(probe).toBeLessThan(apply)
    expect(script).toContain('api --input-type=module')
    expect(script).toContain('SELECT max(version)::int FROM schema_migrations')
    expect(script).toContain('rollback image migration tail is older than live schema')
    expect(script).toContain('rollback image lacks migration ${version}')
    expect(script).toContain('BEGIN READ ONLY')
    expect(script).toContain('SELECT version,name,checksum FROM schema_migrations ORDER BY version ASC')
    expect(script).toContain('verifyAppliedMigrations(result.rows,migrations)')
    expect(metadata.expectedMigrationVersion).toBe(218)
    expect(script).toContain('for(let version=1;version<=expected;version+=1)')
    expect(script).not.toContain('DROP DATABASE')
    expect(script).not.toContain('DELETE FROM schema_migrations')
  })

  it('never removes volumes and persists an explicit failure state', () => {
    const script = source()

    expect(script).not.toMatch(/compose (?:down|rm)\b/)
    expect(script).not.toContain('--volumes')
    expect(script).not.toMatch(/compose up[^\n]*\bmigrate\b/)
    expect(script).toContain("fail health_failed 'rollback containers did not become healthy")
    expect(script).toContain('requires_manual_recovery:mutationStarted&&process.env.phase!=="healthy"')
    expect(script).toContain('services may be partially switched')
    expect(script).toContain('compose_ps_evidence')
    expect(script).toContain("state interrupted 'rollback was interrupted after mutation began")
    expect(script).toContain('fs.renameSync(temporary,target)')
    expect(script).toContain("state healthy 'rollback completed and target release identity is healthy'")
  })

  it('shares a canonical lock and project with deploy and bounds health timeout', () => {
    const script = source()
    expect(script).toContain('${ECS_DEPLOY_LOCK_PATH:?ECS_DEPLOY_LOCK_PATH is required}')
    expect(script).toContain('exec 9>"$ECS_DEPLOY_LOCK_PATH"')
    expect(script).toContain('flock -n 9')
    expect(script).toContain('${ECS_COMPOSE_PROJECT:-merchant-production}')
    expect(script).toContain('-p "$project"')
    expect(script).toContain('ECS_ROLLBACK_HEALTH_TIMEOUT_SECONDS must be an integer from 30 to 900')
    expect(script).toContain('rollback state must be stored outside the mutable repository')
    expect(script).toContain('rollback state directory must not be group/world writable')
    expect(script).toContain('flag:"wx"')
    expect(script).toContain('ECS deploy lock parent must not be group/world writable')
  })
})
