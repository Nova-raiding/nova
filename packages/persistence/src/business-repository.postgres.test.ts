import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresBusinessRepository } from './business-repository.js'
import { visibleProductIds } from './product-brand-visibility.js'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL ?? process.env.PLATFORM_MEDIA_SPEC_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

function databaseUrl(base: URL, databaseName: string): string {
  const result = new URL(base)
  result.pathname = `/${databaseName}`
  return result.toString()
}

describe('PostgresBusinessRepository normalized projections', () => {
  postgresIt('projects task brand ids through real PostgreSQL for present, missing, and null brands', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `business_repository_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined

    let primaryFailure: unknown
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: databaseUrl(base, databaseName) })
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))

      await database.query("INSERT INTO workspaces (id,status) VALUES ('ws_business_repository','active')")
      await database.query(`INSERT INTO platform_accounts
        (id,workspace_id,platform,remote_account_id,credential_ref,token_state)
        VALUES ('account_business_repository','ws_business_repository','jd','remote-account','secret://test','connected')`)
      await database.query(`INSERT INTO brands (id,workspace_id,name)
        VALUES ('brand_business_repository','ws_business_repository','Regression brand')`)
      await database.query(`INSERT INTO products
        (id,workspace_id,platform,platform_account_id,store_name,remote_product_id,title,source)
        VALUES ('product_business_repository','ws_business_repository','jd','account_business_repository','Regression store','remote-product','Regression product','official_api')`)

      const repository = new PostgresBusinessRepository(database, { normalizedProjection: true })
      const task = (entityVersion: number, brandId?: string) => ({
        workspaceId: 'ws_business_repository',
        entityType: 'task' as const,
        entityId: 'task_business_repository',
        entityVersion,
        payload: {
          id: 'task_business_repository',
          workspaceId: 'ws_business_repository',
          productId: 'product_business_repository',
          platform: 'jd',
          accountId: 'account_business_repository',
          brandId,
          state: 'blocked_missing_facts',
        },
      })

      await repository.save(task(1, 'brand_business_repository'))
      await expect(database.query(`SELECT brand_id FROM tasks
        WHERE workspace_id='ws_business_repository' AND id='task_business_repository'`))
        .resolves.toMatchObject({ rows: [{ brand_id: 'brand_business_repository' }] })

      await repository.save(task(2, 'brand_does_not_exist'))
      await expect(database.query(`SELECT brand_id FROM tasks
        WHERE workspace_id='ws_business_repository' AND id='task_business_repository'`))
        .resolves.toMatchObject({ rows: [{ brand_id: null }] })

      await repository.save(task(3))
      await expect(database.query(`SELECT brand_id FROM tasks
        WHERE workspace_id='ws_business_repository' AND id='task_business_repository'`))
        .resolves.toMatchObject({ rows: [{ brand_id: null }] })
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      await withPostgresFixtureCleanup(async () => {
        await database?.end()
        await dropDrainedPostgresFixture(admin, databaseName)
      }, primaryFailure, [
        () => admin.end(),
      ])
    }
  }, 120_000)

  /**
   * The durable product page and the in-memory catalog predicate are the two
   * expressions of one permission boundary (`product-brand-visibility.ts`):
   * `GET /v1/products` and `workspace.metrics` answer with whichever backend is
   * configured, so a brand restricted member must see the same products either
   * way, and the point read must agree with both.
   *
   * The regressions this pins, in both directions:
   *
   *   - the SQL clause was `EXISTS(granted canonical) OR NOT EXISTS(any
   *     canonical)`, so a legacy product with no canonical row stayed visible
   *     even when its own brand and every task brand on it were ungranted;
   *   - the clause that replaced it kept a task-brand fallback, so a
   *     canonical-row-less product whose task carried a granted brand was still
   *     listed — while the point read (`assertProductBrandAccess`) and MCP
   *     `catalog.search` hid the same product. Reproduced over real HTTP: one
   *     legacy product was listed, answered 404 on the point read, and was
   *     absent from `catalog.search`.
   *
   * The rule is now the narrow one — a granted canonical row, nothing else — so
   * `visibleProductIds`, the in-memory predicate this page is compared against,
   * is asserted here on the same fixture rather than described in a comment.
   */
  postgresIt('scopes the durable product page by the same brand predicate as the in-memory catalog filter', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `business_repository_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined

    let primaryFailure: unknown
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: databaseUrl(base, databaseName) })
      const migrations = await loadMigrations()
      await new MigrationRunner(database, migrations).run()

      const workspaceId = 'ws_brand_scope_durable'
      await database.query('INSERT INTO workspaces (id,status) VALUES ($1,$2)', [workspaceId, 'active'])
      await database.query(`INSERT INTO platform_accounts
        (id,workspace_id,platform,remote_account_id,credential_ref,token_state)
        VALUES ('account_brand_scope',$1,'jd','remote-account','secret://test','connected')`, [workspaceId])
      await database.query(`INSERT INTO brands (id,workspace_id,name)
        VALUES ('brand_visible',$1,'可读品'), ('brand_hidden',$1,'不可读品')`, [workspaceId])

      // `products.brand_id` is a stored generated column over `data->>'brandId'`
      // (migration 099) and migration 106 keeps a canonical row's brand equal to
      // it, so the fixture has to carry the brand the way the API writes it.
      const product = async (id: string, title: string, brandId?: string) => {
        await database!.query(`INSERT INTO products
          (id,workspace_id,platform,platform_account_id,store_name,remote_product_id,title,source,data)
          VALUES ($1,$2,'jd','account_brand_scope','可读店铺',$3,$4,'official_api',$5::jsonb)`,
          [id, workspaceId, `remote-${id}`, title, JSON.stringify(brandId ? { brandId } : {})])
      }
      const canonical = async (id: string, legacyProductId: string, brandId: string) => {
        await database!.query(`INSERT INTO canonical_products
          (id,workspace_id,brand_id,legacy_product_id,title,facts,facts_revision)
          VALUES ($1,$2,$3,$4,$5,'{"a":1}'::jsonb,1)`,
          [id, workspaceId, brandId, legacyProductId, `canonical ${id}`])
      }
      const task = (id: string, productId: string, brandId?: string) => ({
        workspaceId,
        entityType: 'task' as const,
        entityId: id,
        entityVersion: 1,
        payload: { id, workspaceId, productId, platform: 'jd', accountId: 'account_brand_scope', ...(brandId ? { brandId } : {}), state: 'blocked_missing_facts' },
      })

      await product('P_legacy_hidden', '无 canonical 且任务属于不可读品的商品', 'brand_hidden')
      await product('P_canon_granted', 'canonical 绑定可读品', 'brand_visible')
      await product('P_canon_hidden', 'canonical 绑定不可读品', 'brand_hidden')
      await product('P_legacy_nobrand', '无 canonical 也无品信号')
      await product('P_legacy_mixed', '无 canonical，任务跨可读与不可读品')
      await canonical('canon_granted', 'P_canon_granted', 'brand_visible')
      await canonical('canon_hidden', 'P_canon_hidden', 'brand_hidden')

      const repository = new PostgresBusinessRepository(database, { normalizedProjection: true })
      await repository.save(task('task_legacy_hidden', 'P_legacy_hidden', 'brand_hidden'))
      await repository.save(task('task_canon_granted', 'P_canon_granted', 'brand_visible'))
      await repository.save(task('task_canon_hidden', 'P_canon_hidden', 'brand_hidden'))
      await repository.save(task('task_legacy_nobrand', 'P_legacy_nobrand'))
      await repository.save(task('task_mixed_granted', 'P_legacy_mixed', 'brand_visible'))
      await repository.save(task('task_mixed_hidden', 'P_legacy_mixed', 'brand_hidden'))

      const pageIds = async (accessibleBrandIds?: string[]) => {
        const page = await repository.listProductsPage(workspaceId, { limit: 100, offset: 0, ...(accessibleBrandIds ? { accessibleBrandIds } : {}) })
        return page.items.map(item => (item as { id: string }).id).sort()
      }
      // The in-memory twin, over the same canonical rows the SQL reads. The
      // durable page has to answer exactly this, whichever backend is
      // configured; the assertions below compare the two answers directly.
      const canonicalRows = (await database.query<{ brand_id: string; legacy_product_id: string | null }>(
        'SELECT brand_id, legacy_product_id FROM canonical_products WHERE workspace_id=$1', [workspaceId]))
        .rows.map(row => ({ brandId: row.brand_id, sourceProductId: row.legacy_product_id }))
      const inMemoryIds = (brandIds?: string[]) => [...visibleProductIds(brandIds, canonicalRows) ?? []].sort()

      // A granted canonical row is the whole rule: a legacy product with no
      // canonical row is hidden even when a task on it carries the granted brand
      // (`P_legacy_mixed`), and a product whose canonical row is bound to another
      // brand is hidden even when its own brand_id names the granted one.
      const grantedOnly = await pageIds(['brand_visible'])
      expect(grantedOnly, 'products visible to a member granted only brand_visible').toEqual(['P_canon_granted'])
      expect(grantedOnly, 'the durable page answers what the in-memory predicate answers').toEqual(inMemoryIds(['brand_visible']))
      // Nothing is filtered for a workspace wide member: `accessibleBrandIds`
      // absent means "no brand condition", and the handler only omits it then.
      expect(await pageIds()).toEqual(['P_canon_granted', 'P_canon_hidden', 'P_legacy_hidden', 'P_legacy_mixed', 'P_legacy_nobrand'])
      // The mirror image: the hidden brand keeps its own canonical product and
      // nothing else.
      const hiddenOnly = await pageIds(['brand_hidden'])
      expect(hiddenOnly).toEqual(['P_canon_hidden'])
      expect(hiddenOnly).toEqual(inMemoryIds(['brand_hidden']))
      // No grant at all is not the same as workspace wide: a restricted member
      // holding no grant reads no product, legacy or not. This is the price of
      // the narrow direction — the page used to hand back every canonical-row-less
      // product here.
      expect(await pageIds([])).toEqual([])
      expect(inMemoryIds([])).toEqual([])
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      await withPostgresFixtureCleanup(async () => {
        await database?.end()
        await dropDrainedPostgresFixture(admin, databaseName)
      }, primaryFailure, [
        () => admin.end(),
      ])
    }
  }, 120_000)
})
