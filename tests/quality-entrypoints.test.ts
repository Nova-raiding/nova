import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PLATFORM_CAPABILITY_CONTRACT_CAPABILITIES,
  PLATFORM_CAPABILITY_CONTRACT_PLATFORMS,
} from '../packages/connectors/src/platform-preflight.js'
import { NON_HERMETIC_TEST_FILES } from './test-suite-isolation.js'
import { ISOLATED_REDIS_TEST_FILES } from '../vitest.redis.config.js'
import {
  UNSCHEDULED_BROWSER_SPECS,
  UNCOLLECTED_VITEST_TEST_FILES,
  brokenDocumentTestReferences,
  browserSpecFilesOnDisk,
  entrypointTestFiles,
  findUnscheduledBrowserSpecs,
  findUncollectedVitestTests,
  staleManifestEntries,
  vitestTestFilesOnDisk,
} from './test-entrypoint-coverage.js'
import { UNINVOKED_SCRIPTS, uninvokedScriptNames } from './package-script-entrypoints.js'

const root = resolve(import.meta.dirname, '..')
const packageJsonSource = readFileSync(resolve(root, 'package.json'), 'utf8')
const packageJson = JSON.parse(packageJsonSource) as {
  scripts: Record<string, string>
}
const LEGACY_NON_RELEASE_GATES = new Set([
  'tests/local-docker-release-gate.test.ts',
])
const CRITICAL_DEFAULT_RELEASE_GATES = [
  'tests/mcp-integration-mode-release-gate.test.ts',
  'tests/mcp-oauth-production-script.test.ts',
  'tests/kubernetes-release-gate.test.ts',
  'tests/payment-gateway-process.integration.test.ts',
  'apps/api/src/payment-capability-status.test.ts',
  'apps/api/src/payment-reconciliation-worker.e2e.test.ts',
  'packages/ai/src/relay-usage.test.ts',
  'packages/ai/src/relay-pricing.test.ts',
  'packages/ai/src/video-generator.test.ts',
] as const

function script(name: string): string {
  const command = packageJson.scripts[name]
  if (!command) throw new Error(`required package script is missing: ${name}`)
  return command
}

function filesUnder(directory: string): string[] {
  return readdirSync(resolve(root, directory), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => relative(root, resolve(entry.parentPath, entry.name)).replaceAll('\\', '/'))
}

describe('quality entrypoint coverage', () => {
  it('keeps release gate script names unique in the source manifest', () => {
    const occurrences = packageJsonSource.match(/^\s*"test:release-gates"\s*:/gm) ?? []
    expect(occurrences).toHaveLength(1)
  })

  it('keeps the capability evidence fixture in lockstep with the platform capability contract', () => {
    // The example fixture is what `npm run infra:validate` feeds the capability
    // evidence gate, so a new contract capability that the fixture never adds
    // turns every CI verify run red. Pin both sides to the same key set.
    const fixture = JSON.parse(readFileSync(resolve(root, 'doc/todo/platform/platform-capability-evidence.example.json'), 'utf8')) as {
      platforms?: Array<{ platform?: string; capabilities?: Record<string, { state?: string }> }>
    }
    const platforms = fixture.platforms ?? []
    expect(platforms.map(item => item.platform)).toEqual([...PLATFORM_CAPABILITY_CONTRACT_PLATFORMS])

    for (const item of platforms) {
      const keys = Object.keys(item.capabilities ?? {}).sort()
      expect(keys, `${item.platform} capability keys drifted from PLATFORM_CAPABILITY_CONTRACT_CAPABILITIES`).toEqual([...PLATFORM_CAPABILITY_CONTRACT_CAPABILITIES].sort())
      // The fixture ships in the repository, so every entry must stay an honest
      // placeholder. Claiming verified evidence here would be fabricated proof.
      const unsupportedStates = Object.entries(item.capabilities ?? {})
        .filter(([, evidence]) => evidence?.state !== 'unverified')
        .map(([capability, evidence]) => `${item.platform}.${capability}=${String(evidence?.state)}`)
      expect(unsupportedStates, 'the example fixture must not claim verified capability evidence').toEqual([])
    }
  })

  it('keeps the root check wired to the deterministic entrypoints, including the mutation gate', () => {
    const check = script('check')
    expect(script('test')).toContain('scripts/run-safe-tests-sharded.ts')
    expect(check).toContain('npm run typecheck')
    expect(check).toContain('npm run release:metadata:validate')
    expect(check).toContain('npm run build:ops-console')
    expect(check).toContain('npm run build:merchant-studio')
    expect(check).toContain('npm run test:plugin-import-contract')
    expect(script('test:plugin-import-contract')).toContain('apps/plugin/skills/six-platform-public-import/scripts/extract-product.test.mjs')
    expect(script('test:plugin-import-contract')).toContain('.codex-marketplace/plugins/merchant-marketing/skills/six-platform-public-import/scripts/extract-product.test.mjs')
    // `invariants:verify` was the only mechanism in this repository that proves
    // other assertions can fail, and nothing executed it: the 23/23 headline
    // was a one-off run, not a gate. The strict pass needs an isolated
    // PostgreSQL fixture; the `check` step tolerates its absence and reports
    // NOT RUN rather than folding it into a green.
    expect(check).toContain('npm run invariants:check')
    expect(script('invariants:verify')).toContain('scripts/invariant-mutation-gate.ts')
    expect(script('invariants:verify')).not.toContain('--tolerate-missing-bindings')
    expect(script('invariants:check')).toContain('--tolerate-missing-bindings')
  })

  it('collects every test file on disk into an enumerated entrypoint ledger', () => {
    // Side one: an actual enumeration (`vitest list --filesOnly` against the
    // real configuration) plus the launcher manifests and script arguments.
    // Side two: a scan of the whole repository, `.codex-marketplace/**` and
    // `dogfood/**` included — the directories the old scan root left out, which
    // is where six uncollected plugin tests and a dead import were hiding.
    const onDisk = vitestTestFilesOnDisk(root)
    expect(onDisk.some(file => file.startsWith('.codex-marketplace/')), 'the scan must include .codex-marketplace/**').toBe(true)
    expect(onDisk.some(file => file.startsWith('dogfood/')), 'the scan must include dogfood/**').toBe(true)
    expect(onDisk.length).toBeGreaterThan(500)

    const collected = entrypointTestFiles(root)
    expect(collected.size, 'the enumeration returned nothing, so "collected" would be vacuously true').toBeGreaterThan(0)
    expect(staleManifestEntries(root), 'an entrypoint list names a file that no longer exists').toEqual([])

    expect(findUncollectedVitestTests(root)).toEqual(UNCOLLECTED_VITEST_TEST_FILES.map(entry => entry.file))
    for (const entry of UNCOLLECTED_VITEST_TEST_FILES) {
      expect(onDisk).toContain(entry.file)
      expect(entry.reason.length, `${entry.file} must explain itself in a sentence, not a word`).toBeGreaterThan(80)
    }
  }, 15_000)

  it('schedules every browser spec in a Playwright project or a runner argument', () => {
    expect(browserSpecFilesOnDisk(root).length).toBeGreaterThan(0)
    expect(findUnscheduledBrowserSpecs(root)).toEqual(UNSCHEDULED_BROWSER_SPECS.map(entry => entry.file))
    for (const entry of UNSCHEDULED_BROWSER_SPECS) {
      expect(browserSpecFilesOnDisk(root)).toContain(entry.file)
      expect(entry.reason.length).toBeGreaterThan(80)
    }
  })

  it('keeps every document reference to a test file pointing at a file that exists', () => {
    expect(brokenDocumentTestReferences(root)).toEqual([])
  })

  it('names every package.json script that no entrypoint invokes', () => {
    // A script nothing invokes is invisible: the four Alibaba Cloud /
    // object-storage evidence commands appear in no document, no runbook and
    // no caller, so the whole evidence chain had to be reconstructed by hand.
    // Anything new that nobody calls must be registered with a reason.
    const registered = new Set(UNINVOKED_SCRIPTS.map(entry => entry.script))
    for (const entry of UNINVOKED_SCRIPTS) {
      expect(packageJson.scripts[entry.script], `${entry.script} is registered but no longer exists`).toBeDefined()
      expect(entry.requires.length).toBeGreaterThan(10)
      expect(entry.reason.length).toBeGreaterThan(60)
    }
    const unregistered = uninvokedScriptNames(root).filter(name => !registered.has(name))
    expect(unregistered, 'these scripts have no caller and no register entry').toEqual([])
  })

  it('keeps the commercial read-boundary acceptance runner behind a named entrypoint', () => {
    // `scripts/verify-commercial-read-boundaries.ts` is a fail-closed security
    // acceptance runner — real PostgreSQL 17, row-level security, a signed OIDC
    // identity, the HTTP route and the native MCP transport — and it had no
    // package.json script at all, so nothing could invoke it and the inventory
    // above could not even see the file. It has a named entrypoint now, and the
    // register entry in `package-script-entrypoints.ts` records the environment
    // it needs. Promoting it into `check` is a deliberate decision, not a side
    // effect of discovering the file, so pin the exclusion here as well.
    expect(script('verify:commercial-read-boundaries')).toBe('tsx scripts/verify-commercial-read-boundaries.ts')
    expect(script('check')).not.toContain('verify:commercial-read-boundaries')
    expect(UNINVOKED_SCRIPTS.map(entry => entry.script)).toContain('verify:commercial-read-boundaries')
  })

  it('keeps all fail-closed gate tests in the explicit release suite', () => {
    const releaseGate = script('test:release-gates')
    const missing = filesUnder('tests')
      .filter(file => /^tests\/[^/]+-gate\.test\.ts$/.test(file))
      .filter(file => !LEGACY_NON_RELEASE_GATES.has(file))
      .filter(file => !releaseGate.includes(file))

    expect(missing).toEqual([])
    expect(script('test')).toContain('scripts/run-safe-tests-sharded.ts')
    expect(script('test:local-release-gate')).toContain('--config vitest.runtime.config.ts tests/local-docker-release-gate.test.ts')
    for (const contract of [
      'tests/quality-entrypoints.test.ts',
      'tests/mcp-surface-contract.test.ts',
      'tests/openapi-contract.test.ts',
      'tests/ops-api-surface.test.ts',
      'tests/operations-scripts.test.ts',
      'tests/runtime-db-role.test.ts',
      'tests/ui-production-contract.test.ts',
      'packages/persistence/src/migration-100.test.ts',
      'packages/persistence/src/migration-101.test.ts',
      'packages/persistence/src/migration-102.test.ts',
      'packages/persistence/src/migration-103.test.ts',
      'packages/persistence/src/migration-104.test.ts',
      'packages/persistence/src/migration-105.test.ts',
      'packages/persistence/src/migration-106.test.ts',
      'packages/persistence/src/migration-110.test.ts',
    ]) {
      expect(releaseGate).toContain(contract)
    }
  })

  it('runs critical MCP, worker, payment, and usage evidence checks from the default release entrypoint', () => {
    const releaseGate = script('test:release-gates')
    for (const gate of CRITICAL_DEFAULT_RELEASE_GATES) {
      expect(releaseGate.split(/\s+/u).filter(argument => argument === gate)).toHaveLength(1)
    }

    // The attack matrix needs a disposable PostgreSQL instance, so the safe
    // default process enforces its dedicated launcher rather than pretending
    // to execute it against an absent or shared database.
    expect(script('test:postgres:isolated')).toContain('scripts/run-isolated-postgres-tests.ts')
    const isolatedRunner = readFileSync(resolve(root, 'scripts/run-isolated-postgres-tests.ts'), 'utf8')
    expect(isolatedRunner).toContain("from '../vitest.postgres.config.js'")
    const postgresManifest = readFileSync(resolve(root, 'vitest.postgres.config.ts'), 'utf8')
    expect(postgresManifest).toContain("'tests/postgres-rls-attack-matrix.postgres.test.ts'")
  })

  it('keeps the deliberately server-only control planes explicit', () => {
    const auditSource = readFileSync(resolve(root, 'scripts/audit-ops-surface.mjs'), 'utf8')
    // Not only feature flags: `ops.platform.store.record.create` is the other
    // deliberately UI-less control plane (see the set's own comment in
    // `scripts/audit-ops-surface.mjs`). Adding a UI for either entry should
    // remove it from this list and from the audit's set in the same change.
    const serverOnly = [
      'ops.feature-flags.list',
      'ops.feature-flag.upsert',
      'ops.feature-flag.emergency.set',
      'ops.feature-flag.events',
      'ops.feature-flag.evaluate',
      'ops.platform.store.record.create',
    ]
    for (const method of serverOnly) expect(auditSource).toContain(`'${method}'`)

    const report = JSON.parse(execFileSync(process.execPath, ['scripts/audit-ops-surface.mjs'], {
      cwd: root,
      encoding: 'utf8',
    })) as {
      server_only_methods?: string[]
      unregistered_server_only?: string[]
      unreferenced?: string[]
    }
    expect(report.server_only_methods).toEqual([...serverOnly].sort())
    expect(report.unregistered_server_only).toEqual([])
    expect(report.unreferenced).toEqual([])
  })

  it('keeps non-hermetic coverage explicit instead of silently passing it in the default suite', () => {
    expect(NON_HERMETIC_TEST_FILES).toHaveLength(36)
    expect(NON_HERMETIC_TEST_FILES).toContain('tests/postgres-rls-attack-matrix.postgres.test.ts')
    expect(NON_HERMETIC_TEST_FILES).toContain('packages/persistence/src/support-repository-sla-filter.postgres.test.ts')
    expect(NON_HERMETIC_TEST_FILES).toContain('packages/persistence/src/migration-218-release.postgres.test.ts')
    expect(script('test:runtime:isolated')).toContain('--config vitest.runtime.config.ts')
    expect(script('test:postgres:isolated')).toContain('scripts/run-isolated-postgres-tests.ts')
    // `REDIS_URL`-gated files reported every assertion as pending in the default
    // suite. They now have their own fail-closed launcher instead.
    expect(script('test:redis:isolated')).toContain('scripts/run-isolated-redis-tests.ts')
    expect(ISOLATED_REDIS_TEST_FILES).toEqual([
      'packages/workers/src/durable-redis-recovery.test.ts',
      'apps/worker/src/redis-queue-transport.test.ts',
    ])
    for (const file of ISOLATED_REDIS_TEST_FILES) expect(NON_HERMETIC_TEST_FILES).toContain(file)
    expect(readFileSync(resolve(root, 'scripts/run-isolated-redis-tests.ts'), 'utf8')).toContain('numPendingTests !== 0')
    expect(script('test:browser:ops:jit')).toContain('scripts/run-ops-oidc-e2e.ts')
    expect(readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')).toContain('...NON_HERMETIC_TEST_FILES')
    // The legacy canonical API contract still embeds merchant bearer login.
    // It is quarantined, not claimed as passing until its signed, isolated
    // runtime migration is implemented. Keep that exact gap visible.
    expect(NON_HERMETIC_TEST_FILES).toContain('apps/api/src/canonical-backfill-contract.test.ts')
  })

  it('tracks the current migration tail and required CI quality entrypoints', () => {
    const migrationVersions = filesUnder('packages/persistence/src/migrations')
      .map(file => /\/(\d{3})_[^/]+\.sql$/.exec(file)?.[1])
      .filter((version): version is string => version !== undefined)
      .map(Number)
    const latestMigration = Math.max(...migrationVersions).toString().padStart(3, '0')

    const releaseGates = script('test:release-gates')
    // The release suite may use the shared migration-chain test instead of
    // listing every late migration contract individually. The root suite
    // still executes the version-specific test file.
    expect(
      releaseGates.includes(`packages/persistence/src/migration-${latestMigration}.test.ts`) ||
        releaseGates.includes('packages/persistence/src/migration.test.ts'),
    ).toBe(true)

    const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
    for (const command of [
      'npm run check',
      'npm run test:release-gates',
      'npm run test:load',
      'npm run build',
      'npm run infra:validate',
    ]) {
      expect(ci).toContain(command)
    }

    // A migration that is only covered by a source-level contract can still
    // fail when applied by PostgreSQL. Keep the CI acceptance list aligned
    // with the migration tail as well as the release-gate list.
    expect(ci).toContain('npm run test:release-gates')
    // Schema-dump acceptance is version-sensitive: the CI workflow must pin
    // the PostgreSQL 17 client instead of relying on an image-host default.
    expect(ci).toContain('Install PostgreSQL 17 client for schema-dump acceptance')
    expect(ci).toContain('PG_DUMP_BIN: /usr/lib/postgresql/17/bin/pg_dump')
  })

  it('keeps the current late-migration acceptance tests in CI', () => {
    const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
    const lateMigrationTests = filesUnder('packages/persistence/src')
      .filter(file => /\/migration-(08[3-9]|09[0-9]|100|101|102|103|104|105)\.test\.ts$/.test(file))
    expect(lateMigrationTests.length).toBeGreaterThan(0)
    for (const file of lateMigrationTests) expect(ci).toContain(file)
  })
})
