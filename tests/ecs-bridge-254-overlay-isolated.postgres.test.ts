import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as crypto from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { buildBridgeReview } from '../infra/scripts/prepare-ecs-bridge-254-review.mjs'
import { buildBridgeOverlay } from '../infra/scripts/overlay-ecs-bridge-254-review.mjs'
import { loadMigrations, MigrationRunner, migrationChecksumBaseline, verifyAppliedMigrations, type AppliedMigration } from '../packages/persistence/src/migration.js'
import { createIsolatedOpsFixture, type IsolatedOpsFixture } from './isolated-ops-fixture.js'

const migrationCommit = 'd0552b975e69f4ba713ec1c003078f521b69f51a'

describe('B-derived 242/254 bridge on an owned PG17 fixture', () => {
  it('accepts only the complete checksummed 242 and 254 histories on the same isolated database', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'bridge-254-pg17-'))
    let fixture: IsolatedOpsFixture | undefined
    let pool: Pool | undefined
    try {
      const review = join(parent, 'review')
      const overlay = join(parent, 'overlay')
      buildBridgeReview({ migrationCommit, output: review })
      const manifest = buildBridgeOverlay({ review, output: overlay })
      expect(manifest).toMatchObject({ status: 'review_only', deployable: false, runtime_verified: false })
      const source = readFileSync(join(overlay, 'overlay-source/packages/persistence/src/migration.ts'), 'utf8')
      const body = source.match(/export function verifyBridgeMigrationPrefix\([\s\S]*?\): 242 \| 254 \{([\s\S]*?)\n\}\n/u)?.[1]
      expect(body).toBeDefined()
      const verify = new Function('verifyAppliedMigrations', 'migrationChecksumBaseline', `return (applied, expected, mode) => {${body}\n}`)(
        verifyAppliedMigrations, migrationChecksumBaseline,
      ) as (applied: AppliedMigration[], expected: Awaited<ReturnType<typeof loadMigrations>>, mode: string) => number
      // This review artifact is frozen at 254 even when the application has
      // newer migrations. Keep the fixture and checksum comparison on that
      // historical chain.
      const migrations = (await loadMigrations()).slice(0, 254)
      expect(migrations).toHaveLength(254)
      for (const migration of migrations) {
        const name = `${String(migration.version).padStart(3, '0')}_${migration.name}.sql`
        expect(readFileSync(join(overlay, 'overlay-source/packages/persistence/src/migrations', name), 'utf8'), name).toBe(migration.sql)
      }

      fixture = await createIsolatedOpsFixture({ evidenceDir: join(parent, 'fixture-evidence') })
      pool = new Pool({ connectionString: fixture.acceptanceDatabaseUrls!.legacyBackfill, max: 2 })
      const observed = async (): Promise<AppliedMigration[]> => (await pool!.query<AppliedMigration>('SELECT version, name, checksum FROM schema_migrations ORDER BY version')).rows
      await new MigrationRunner(pool, migrations.slice(0, 242)).run()
      expect(verify(await observed(), migrations, 'prefix_242_or_254')).toBe(242)
      await new MigrationRunner(pool, migrations.slice(0, 243)).run()
      const intermediate = await observed()
      expect(intermediate).toHaveLength(243)
      expect(() => verify(intermediate, migrations, 'prefix_242_or_254')).toThrow('exactly 242 or 254')
      await new MigrationRunner(pool, migrations).run()
      expect(verify(await observed(), migrations, 'prefix_242_or_254')).toBe(254)
      const finalHistory = await observed()
      expect(() => verify(finalHistory, migrations, 'prefix_242_or_244')).toThrow('not enabled')

      const catalogSource = readFileSync(join(overlay, 'overlay-source/packages/persistence/src/commercial-catalog-repository.ts'), 'utf8')
      const catalogCode = ts.transpileModule(catalogSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
      const exports: Record<string, any> = {}
      new Function('require', 'exports', catalogCode)((id: string) => {
        if (id === 'node:crypto') return crypto
        throw new Error(`unexpected B-derived catalog import: ${id}`)
      }, exports)
      const catalog = new exports.PostgresCommercialCatalogRepository(pool)
      const rates = await catalog.listRates()
      expect(rates).toContainEqual(expect.objectContaining({ actionCode: 'ocr.extract', pricingMode: 'variable', integerPoints: null, ruleExecutable: false,
        blockers: expect.arrayContaining(['BRIDGE_VARIABLE_OCR_RATE_UNSUPPORTED']) }))
      await expect(catalog.resolveApprovedRate('ocr.extract')).rejects.toMatchObject({ code: 'RATE_CARD_UNAVAILABLE' })
      await expect(catalog.resolveApprovedRate('text.generate')).resolves.toMatchObject({ actionCode: 'text.generate', integerPoints: 1 })
    } finally {
      try {
        await pool?.end()
      } finally {
        if (fixture) {
          const disposed = await fixture.dispose()
          if (disposed.leftRunning.length) throw new Error('isolated PG17 fixture cleanup requires inspection')
        }
        rmSync(parent, { recursive: true, force: true })
      }
    }
  }, 240_000)
})
