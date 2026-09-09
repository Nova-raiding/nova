import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresBrandUnitRepository } from './brand-unit-repository.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

function databaseConnection(base: URL, database: string, user?: string, password?: string) {
  const url = new URL(base)
  url.pathname = `/${database}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

describe('brand profile association PostgreSQL release evidence', () => {
  postgresIt('persists brand/store/campaign relations and keeps them tenant isolated', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `brand_profile_assoc_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let application: Pool | undefined

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const isolated = new URL(databaseConnection(base, databaseName))
      database = new Pool({ connectionString: isolated.toString() })
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))
      expect(await new MigrationRunner(database, migrations).run()).toEqual([])

      await database.query(`
        INSERT INTO workspaces (id, status)
        VALUES ('brand_assoc_alpha', 'active'), ('brand_assoc_beta', 'active')
      `)
      await database.query(`
        INSERT INTO platform_accounts
          (id, workspace_id, platform, remote_account_id, credential_ref, token_state)
        VALUES
          ('brand_assoc_account_alpha', 'brand_assoc_alpha', 'taobao', 'remote-alpha', 'secret://alpha', 'connected'),
          ('brand_assoc_account_beta', 'brand_assoc_beta', 'taobao', 'remote-beta', 'secret://beta', 'connected')
      `)
      await database.query(`
        INSERT INTO products
          (id, workspace_id, platform, platform_account_id, remote_product_id, title, source, data)
        VALUES
          ('brand_assoc_product_alpha', 'brand_assoc_alpha', 'taobao', 'brand_assoc_account_alpha', 'remote-product-alpha', 'Alpha product', 'fixture', '{"brandId":"brand-profile-shared"}'::jsonb),
          ('brand_assoc_product_beta', 'brand_assoc_beta', 'taobao', 'brand_assoc_account_beta', 'remote-product-beta', 'Beta product', 'fixture', '{"brandId":"brand-profile-shared"}'::jsonb)
      `)

      // A release database starts with runtime table grants revoked. Grant
      // only the merchant-facing tables exercised by this evidence test;
      // forced RLS remains the tenant boundary under test.
      await database.query('GRANT SELECT, INSERT, UPDATE ON brands, brand_store_bindings, canonical_products, product_listings, batch_campaigns, batch_campaign_items TO merchant_app')
      // The canonical legacy-integrity trigger takes a key-share lock while
      // checking the source product; PostgreSQL requires UPDATE privilege for
      // that lock mode in addition to the read used by the merchant runtime.
      await database.query('GRANT SELECT, UPDATE ON products, platform_accounts TO merchant_app')
      await database.query('GRANT REFERENCES ON products, platform_accounts TO merchant_app')

      application = new Pool({
        connectionString: databaseConnection(base, databaseName, 'merchant_app', 'merchant_app_local_only'),
        max: 2,
      })
      const repository = new PostgresBrandUnitRepository(application)

      // The same brand-unit identifier is deliberately reused in both tenants;
      // all relationship edges must still carry the workspace key.
      await repository.createBrand({ workspaceId: 'brand_assoc_alpha', id: 'brand-profile-shared', name: 'Alpha brand' })
      await repository.createBrand({ workspaceId: 'brand_assoc_beta', id: 'brand-profile-shared', name: 'Beta brand' })
      const alphaBrand = await repository.bindStore({
        workspaceId: 'brand_assoc_alpha', brandId: 'brand-profile-shared', platform: 'taobao', accountId: 'brand_assoc_account_alpha', expectedRevision: 1,
      })
      expect(alphaBrand).toMatchObject({ workspaceId: 'brand_assoc_alpha', id: 'brand-profile-shared', revision: 2, storeBindings: [{ platform: 'taobao', accountId: 'brand_assoc_account_alpha' }] })
      await repository.bindStore({
        workspaceId: 'brand_assoc_beta', brandId: 'brand-profile-shared', platform: 'taobao', accountId: 'brand_assoc_account_beta', expectedRevision: 1,
      })

      const alphaCanonical = await repository.createCanonicalProduct({
        workspaceId: 'brand_assoc_alpha', id: 'canonical-shared', brandId: 'brand-profile-shared', title: 'Alpha canonical', sourceProductId: 'brand_assoc_product_alpha',
      })
      const betaCanonical = await repository.createCanonicalProduct({
        workspaceId: 'brand_assoc_beta', id: 'canonical-shared', brandId: 'brand-profile-shared', title: 'Beta canonical', sourceProductId: 'brand_assoc_product_beta',
      })
      const alphaListing = await repository.createListing({
        workspaceId: 'brand_assoc_alpha', id: 'listing-shared', brandId: 'brand-profile-shared', canonicalProductId: alphaCanonical.id, platform: 'taobao', accountId: 'brand_assoc_account_alpha', remoteProductId: 'remote-listing-alpha',
      })
      await repository.createListing({
        workspaceId: 'brand_assoc_beta', id: 'listing-shared', brandId: 'brand-profile-shared', canonicalProductId: betaCanonical.id, platform: 'taobao', accountId: 'brand_assoc_account_beta', remoteProductId: 'remote-listing-beta',
      })

      const alphaCampaign = await repository.createCampaign({
        id: 'campaign-shared', workspaceId: 'brand_assoc_alpha', brandId: 'brand-profile-shared', platform: 'taobao', accountId: 'brand_assoc_account_alpha', productIds: ['brand_assoc_product_alpha'],
        targets: [{ productId: 'brand_assoc_product_alpha', canonicalProductId: alphaCanonical.id, listingId: alphaListing.id, platform: 'taobao', accountId: 'brand_assoc_account_alpha' }],
        state: 'draft', idempotencyKey: 'brand-assoc-alpha-campaign',
      })
      expect(alphaCampaign).toMatchObject({ replayed: false, campaign: { workspaceId: 'brand_assoc_alpha', id: 'campaign-shared', brandId: 'brand-profile-shared', items: [{ canonicalProductId: 'canonical-shared', listingId: 'listing-shared', productId: 'brand_assoc_product_alpha', workspaceId: 'brand_assoc_alpha' }] } })

      await expect(repository.getCampaign({ workspaceId: 'brand_assoc_beta', id: alphaCampaign.campaign.id })).resolves.toBeUndefined()
      await expect(repository.listBrands({ workspaceId: 'brand_assoc_beta', brandId: 'brand-profile-shared' })).resolves.toMatchObject([{ workspaceId: 'brand_assoc_beta', storeBindings: [{ accountId: 'brand_assoc_account_beta' }] }])

      const scoped = async (workspaceId: string, sql: string, values: unknown[] = []) => {
        await application!.query('BEGIN')
        try {
          await application!.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId])
          return await application!.query(sql, values)
        } finally {
          await application!.query('ROLLBACK')
        }
      }

      const alphaRows = await scoped('brand_assoc_alpha', `
        SELECT b.workspace_id AS "workspaceId", b.id AS "brandId", s.platform_account_id AS "accountId",
               cp.id AS "canonicalProductId", pl.id AS "listingId", bc.id AS "campaignId", bci.id AS "campaignItemId"
          FROM brands b
          JOIN brand_store_bindings s ON s.workspace_id=b.workspace_id AND s.brand_id=b.id AND s.status='active'
          JOIN canonical_products cp ON cp.workspace_id=b.workspace_id AND cp.brand_id=b.id
          JOIN product_listings pl ON pl.workspace_id=cp.workspace_id AND pl.brand_id=cp.brand_id AND pl.canonical_product_id=cp.id
          JOIN batch_campaign_items bci ON bci.workspace_id=pl.workspace_id AND bci.brand_id=pl.brand_id AND bci.canonical_product_id=pl.canonical_product_id AND bci.listing_id=pl.id
          JOIN batch_campaigns bc ON bc.workspace_id=bci.workspace_id AND bc.id=bci.campaign_id
         WHERE b.id='brand-profile-shared'`)
      expect(alphaRows.rows).toEqual([{
        workspaceId: 'brand_assoc_alpha', brandId: 'brand-profile-shared', accountId: 'brand_assoc_account_alpha', canonicalProductId: 'canonical-shared', listingId: 'listing-shared', campaignId: 'campaign-shared', campaignItemId: 'campaign-shared_item_0001',
      }])

      const betaView = await scoped('brand_assoc_beta', `
        SELECT b.workspace_id AS "workspaceId", b.id AS "brandId", s.platform_account_id AS "accountId",
               cp.id AS "canonicalProductId", pl.id AS "listingId", bc.id AS "campaignId"
          FROM brands b
          LEFT JOIN brand_store_bindings s ON s.workspace_id=b.workspace_id AND s.brand_id=b.id
          LEFT JOIN canonical_products cp ON cp.workspace_id=b.workspace_id AND cp.brand_id=b.id
          LEFT JOIN product_listings pl ON pl.workspace_id=cp.workspace_id AND pl.brand_id=cp.brand_id AND pl.canonical_product_id=cp.id
          LEFT JOIN batch_campaigns bc ON bc.workspace_id=pl.workspace_id AND bc.id='campaign-shared'
         WHERE b.id='brand-profile-shared'
         ORDER BY b.workspace_id`)
      expect(betaView.rows).toEqual([{
        workspaceId: 'brand_assoc_beta', brandId: 'brand-profile-shared', accountId: 'brand_assoc_account_beta', canonicalProductId: 'canonical-shared', listingId: 'listing-shared', campaignId: null,
      }])

      await application.query('BEGIN')
      await application.query("SELECT set_config('app.workspace_id', 'brand_assoc_beta', true)")
      await expect(application.query(`INSERT INTO brands (id, workspace_id, name) VALUES ('brand_assoc_forged', 'brand_assoc_alpha', 'forged')`)).rejects.toMatchObject({ code: '42501' })
      await application.query('ROLLBACK')
    } finally {
      await application?.end()
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
