import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assertCandidateComposeRender, assertContainerOwnership, assertMigrationCompleted, candidateComposeArgs, candidateConfiguration, CANDIDATE_POSTGRES_IMAGE } from '../scripts/merchant-browser-candidate.js'
import { ISOLATED_POSTGRES_IMAGE } from './isolated-ops-fixture.js'

// Regression: ISSUE-001 — Colima saw /private/tmp bind-mounted SQL files as directories.
// Found by /qa on 2026-09-15; migration failed before bootstrap, browser never started.
const candidate = () => candidateConfiguration({}, 'a'.repeat(40), [28081, 28082, 28787, 15439, 16389], '0123456789ab')

describe('candidate frozen migration artifacts', () => {
  it('renders candidate-only PG17, a unique built migration image and zero runtime host binds', () => {
    const value = candidate()
    const rendered = JSON.parse(execFileSync('docker', [...candidateComposeArgs(value), 'config', '--format', 'json'], { env: { ...value.env, PATH: process.env.PATH }, encoding: 'utf8' }))
    expect(() => assertCandidateComposeRender(rendered, value)).not.toThrow()
    expect(rendered.services.migrate.image).toBe(value.migrationImage)
    expect(rendered.services.migrate.volumes ?? []).toEqual([])
    expect(rendered.services.migrate.build.dockerfile).toBe('infra/docker/browser-candidate-migrate.Dockerfile')
    expect(rendered.services.postgres.image).toBe(ISOLATED_POSTGRES_IMAGE)
    expect(rendered.services.postgres.environment.POSTGRES_DB).toBe('merchant')
    expect(rendered.services.migrate.environment).toMatchObject({ PGHOST: 'postgres', PGPORT: '5432', PGDATABASE: 'merchant', PGUSER: 'merchant', DATABASE_URL: 'postgres://merchant_app:merchant_app_local_only@postgres:5432/merchant', OPS_DATABASE_URL: 'postgres://merchant_ops:merchant_ops_local_only@postgres:5432/merchant' })
    const unsafe = structuredClone(rendered)
    unsafe.services.migrate.volumes = [{ type: 'bind', source: '/private/tmp/sql', target: '/ops/ensure-app-role.sql' }]
    expect(() => assertCandidateComposeRender(unsafe, value)).toThrow(/refuses host bind/)
    const apiBind = structuredClone(rendered)
    apiBind.services.api.volumes.push({ type: 'bind', source: '/business', target: '/business' })
    expect(() => assertCandidateComposeRender(apiBind, value)).toThrow(/refuses host bind/)
    const pg16 = structuredClone(rendered); pg16.services.postgres.image = 'postgres:16-alpine'
    expect(() => assertCandidateComposeRender(pg16, value)).toThrow(/pinned PG17/)
  })

  it('bakes all four bootstrap/verification files and frozen migration SQL into the pinned PG17 image', () => {
    expect(CANDIDATE_POSTGRES_IMAGE).toBe(ISOLATED_POSTGRES_IMAGE)
    const source = readFileSync('infra/docker/browser-candidate-migrate.Dockerfile', 'utf8')
    expect(source).toContain(`FROM ${ISOLATED_POSTGRES_IMAGE}`)
    for (const [from, to] of [['packages/persistence/src/migrations', '/migrations'], ['infra/scripts/apply-migrations.sh', '/ops/apply-migrations.sh'], ['infra/local/ensure-app-role.sql', '/ops/ensure-app-role.sql'], ['infra/scripts/verify-runtime-db-role.sh', '/ops/verify-runtime-db-role.sh'], ['infra/local/seed-demo.sql', '/ops/seed-demo.sql']]) expect(source).toContain(`COPY ${from} ${to}`)
    expect(source).not.toMatch(/ARG|ENV|VOLUME|curl|wget/)
    expect(readFileSync('infra/local/docker-compose.yml', 'utf8')).toContain('image: postgres:16-alpine')
  })

  it('rejects stale PG16 and a globally shared or foreign-project migration container', () => {
    const value = candidate()
    const inspected = (service: string, image: string) => ({ Config: { Image: image, Labels: { 'com.docker.compose.project': value.project!, 'com.docker.compose.service': service } }, State: { Running: false, Status: 'exited', ExitCode: 0 } })
    expect(() => assertContainerOwnership(inspected('postgres', CANDIDATE_POSTGRES_IMAGE), value, 'postgres')).not.toThrow()
    expect(() => assertContainerOwnership(inspected('postgres', 'postgres:16-alpine'), value, 'postgres')).toThrow(/incorrect image tag/)
    const own = inspected('migrate', value.migrationImage!)
    expect(() => assertMigrationCompleted(own, value)).not.toThrow()
    expect(() => assertMigrationCompleted(inspected('migrate', 'postgres:16-alpine'), value)).toThrow(/incorrect image tag/)
    expect(() => assertMigrationCompleted({ ...own, State: { Running: false, Status: 'exited', ExitCode: 1 } }, value)).toThrow(/did not complete/)
    expect(() => assertMigrationCompleted({ ...own, Config: { ...own.Config, Labels: { ...own.Config.Labels, 'com.docker.compose.project': 'local' } } }, value)).toThrow(/ownership labels/)
  })

  it('does not let external mode render candidate Compose and retains source-freeze/build/cleanup gates', () => {
    const external = candidateConfiguration({ BROWSER_STACK_MODE: 'external', BROWSER_EXPECTED_RELEASE_GIT_SHA: 'a'.repeat(40), BROWSER_EXPECTED_RELEASE_ID: 'release-1', MERCHANT_STUDIO_URL: 'https://merchant.example/', OPS_BASE_URL: 'https://ops.example/' }, '', [], '')
    expect(() => candidateComposeArgs(external)).toThrow(/external mode/)
    const source = readFileSync('scripts/merchant-browser-candidate.ts', 'utf8')
    expect(source).toContain('assertCandidateComposeRender(rendered, candidate)')
    expect(source).toContain('assertMigrationCompleted(')
    expect(source).toContain("'--build', '--force-recreate'")
    expect(source).toContain('assertCandidateGitState(dirtyTracked, existsSync(mergeHead), untrackedSource)')
    expect(source).toContain('await cleanupBrowserCandidate(candidate)')
  })
})
