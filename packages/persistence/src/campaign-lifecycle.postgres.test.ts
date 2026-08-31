import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresBrandUnitRepository } from './brand-unit-repository.js'

const postgresIt = process.env.PLATFORM_MEDIA_SPEC_DATABASE_URL ? it : it.skip

describe('durable campaign lifecycle across repository instances', () => {
  postgresIt('keeps CAS, idempotency and tenant scope after reconnect', async () => {
    const adminUrl = new URL(process.env.PLATFORM_MEDIA_SPEC_DATABASE_URL!)
    const databaseName = `campaign_lifecycle_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: adminUrl.toString() })
    let database: Pool | undefined
    let appA: Pool | undefined
    let appB: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const databaseUrl = new URL(adminUrl); databaseUrl.pathname = `/${databaseName}`
      database = new Pool({ connectionString: databaseUrl.toString() })
      await new MigrationRunner(database, (await loadMigrations()).filter(item => item.version <= 68)).run()
      await database.query(`INSERT INTO workspaces (id,status) VALUES ('ws_campaign_a','active'),('ws_campaign_b','active')`)
      await database.query(`INSERT INTO platform_accounts (id,workspace_id,platform,remote_account_id,credential_ref,token_state) VALUES ('acct_campaign','ws_campaign_a','taobao','remote_campaign','secret://campaign','connected')`)
      await database.query(`INSERT INTO brands (id,workspace_id,name) VALUES ('brand_campaign','ws_campaign_a','Campaign Brand')`)
      await database.query(`INSERT INTO brand_store_bindings (workspace_id,brand_id,platform,platform_account_id) VALUES ('ws_campaign_a','brand_campaign','taobao','acct_campaign')`)
      await database.query(`INSERT INTO canonical_products (id,workspace_id,brand_id,title) VALUES ('canonical_campaign','ws_campaign_a','brand_campaign','Campaign Product')`)
      await database.query(`INSERT INTO product_listings (id,workspace_id,brand_id,canonical_product_id,platform,platform_account_id) VALUES ('listing_campaign','ws_campaign_a','brand_campaign','canonical_campaign','taobao','acct_campaign')`)
      await database.query(`INSERT INTO products (id,workspace_id,platform,platform_account_id,remote_product_id,title,source) VALUES ('product_campaign','ws_campaign_a','taobao','acct_campaign','remote-product','Campaign Product','official_api')`)
      const appUrl = new URL(databaseUrl); appUrl.username = 'merchant_app'; appUrl.password = 'merchant_app_local_only'
      appA = new Pool({ connectionString: appUrl.toString(), max: 2 }); appB = new Pool({ connectionString: appUrl.toString(), max: 2 })
      const first = new PostgresBrandUnitRepository(appA)
      const second = new PostgresBrandUnitRepository(appB)
      const created = await first.createCampaign({ id: 'campaign_durable', workspaceId: 'ws_campaign_a', brandId: 'brand_campaign', platform: 'taobao', accountId: 'acct_campaign', productIds: ['product_campaign'], targets: [{ productId: 'product_campaign', canonicalProductId: 'canonical_campaign', listingId: 'listing_campaign', platform: 'taobao', accountId: 'acct_campaign' }], state: 'draft' })
      expect(created.campaign.revision).toBe(1)
      const raced = await Promise.allSettled([
        first.transitionCampaignLifecycle({ workspaceId: 'ws_campaign_a', id: 'campaign_durable', operation: 'pause', expectedRevision: 1, idempotencyKey: 'pause-instance-a', reason: 'pause from instance A' }),
        second.transitionCampaignLifecycle({ workspaceId: 'ws_campaign_a', id: 'campaign_durable', operation: 'pause', expectedRevision: 1, idempotencyKey: 'pause-instance-b', reason: 'pause from instance B' }),
      ])
      expect(raced.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(raced.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'CAMPAIGN_REVISION_CONFLICT' } })
      const winnerInput = raced[0]!.status === 'fulfilled' ? { idempotencyKey: 'pause-instance-a', reason: 'pause from instance A' } : { idempotencyKey: 'pause-instance-b', reason: 'pause from instance B' }
      await Promise.all([appA.end(), appB.end()])
      appA = undefined
      appB = new Pool({ connectionString: appUrl.toString(), max: 2 })
      const reconnected = new PostgresBrandUnitRepository(appB)
      await expect(reconnected.getCampaign({ workspaceId: 'ws_campaign_a', id: 'campaign_durable' })).resolves.toMatchObject({ state: 'paused', revision: 2, items: [{ state: 'paused' }] })
      await expect(reconnected.transitionCampaignLifecycle({ workspaceId: 'ws_campaign_a', id: 'campaign_durable', operation: 'pause', expectedRevision: 1, ...winnerInput })).resolves.toMatchObject({ replayed: true, campaign: { state: 'paused', revision: 2 } })
      await expect(reconnected.getCampaign({ workspaceId: 'ws_campaign_b', id: 'campaign_durable' })).resolves.toBeUndefined()
      await expect(reconnected.transitionCampaignLifecycle({ workspaceId: 'ws_campaign_a', id: 'campaign_durable', operation: 'resume', expectedRevision: 2, idempotencyKey: 'resume-reconnected', reason: 'resume after reconnect' })).resolves.toMatchObject({ campaign: { state: 'draft', revision: 3, items: [{ state: 'pending' }] } })
    } finally {
      await Promise.all([appA?.end(), appB?.end()]); await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`); await admin.end()
    }
  }, 120_000)
})
