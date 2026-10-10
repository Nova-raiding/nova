import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const source = process.env.PERSISTENCE_RELEASE_DATABASE_URL

describe.skipIf(!source)('customer delivery tenant RLS PostgreSQL regression', () => {
  const workspaceA = `delivery-tenant-a-${randomUUID()}`
  const workspaceB = `delivery-tenant-b-${randomUUID()}`
  const deliveryA = `delivery-a-${randomUUID()}`
  const deliveryB = `delivery-b-${randomUUID()}`
  const videoA = `video-${randomUUID()}`
  const videoB = `video-${randomUUID()}`
  const itemA = `item-${randomUUID()}`
  const itemB = `item-${randomUUID()}`
  let database: Pool | undefined
  let ops: Pool | undefined

  beforeAll(async () => {
    // The isolated-test runner already migrated this private database. Use
    // unique rows within it and let the runner dispose of the whole fixture.
    database = new Pool({ connectionString: source!, max: 4, connectionTimeoutMillis: 10_000 })

    const opsUrl = new URL(source!)
    opsUrl.username = 'merchant_ops'
    opsUrl.password = 'merchant_ops_local_only'
    ops = new Pool({ connectionString: opsUrl.toString(), max: 1 })

    await database.query('INSERT INTO workspaces(id,status) VALUES($1,\'active\'),($2,\'active\')', [workspaceA, workspaceB])
    for (const [workspaceId, deliveryId, suffix] of [
      [workspaceA, deliveryA, 'alpha'],
      [workspaceB, deliveryB, 'beta'],
    ]) {
      await database.query(`
        INSERT INTO workspace_customer_deliveries
          (id,workspace_id,company_name,created_by_actor_id,updated_by_actor_id)
        VALUES($1,$2,$3,'fixture','fixture')`, [deliveryId, workspaceId, `Customer ${suffix}`])
      await database.query(`
        INSERT INTO workspace_customer_delivery_videos
          (id,workspace_id,delivery_id,title,asset_ref,uploaded_by_actor_id)
        VALUES($1,$2,$3,$4,$5,'fixture')`, [suffix === 'alpha' ? videoA : videoB, workspaceId, deliveryId, `Video ${suffix}`, `asset-${suffix}-${randomUUID()}`])
      await database.query(`
        INSERT INTO workspace_customer_delivery_checklist_items
          (workspace_id,delivery_id,checklist_key,item_key,completed)
        VALUES($1,$2,'system_integration',$3,true)`, [workspaceId, deliveryId, suffix === 'alpha' ? itemA : itemB])
    }
  }, 240_000)

  afterAll(async () => {
    try { await ops?.end() }
    finally { await database?.end() }
  }, 30_000)

  it('isolates delivery records and child rows, and rejects cross-workspace inserts', async () => {
    const client = await ops!.connect()
    try {
      await client.query('BEGIN')

      // Missing tenant context must fail closed for every protected table.
      expect((await client.query('SELECT id FROM workspace_customer_deliveries')).rows).toEqual([])
      expect((await client.query('SELECT id FROM workspace_customer_delivery_videos')).rows).toEqual([])
      expect((await client.query('SELECT delivery_id,item_key FROM workspace_customer_delivery_checklist_items')).rows).toEqual([])

      await client.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceA])

      expect((await client.query('SELECT id,workspace_id FROM workspace_customer_deliveries ORDER BY id')).rows)
        .toEqual([{ id: deliveryA, workspace_id: workspaceA }])
      expect((await client.query('SELECT id,workspace_id FROM workspace_customer_delivery_videos ORDER BY id')).rows)
        .toEqual([{ id: videoA, workspace_id: workspaceA }])
      expect((await client.query('SELECT delivery_id,item_key FROM workspace_customer_delivery_checklist_items ORDER BY item_key')).rows)
        .toEqual([{ delivery_id: deliveryA, item_key: itemA }])

      // A visible row cannot be reassigned into another tenant. Roll back to
      // the savepoint after the expected WITH CHECK violation so the rest of
      // this transaction can continue validating isolation.
      await client.query('SAVEPOINT reject_cross_workspace_delivery_move')
      await expect(client.query(`UPDATE workspace_customer_deliveries
        SET workspace_id=$1 WHERE workspace_id=$2 AND id=$3`, [workspaceB, workspaceA, deliveryA]))
        .rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK TO SAVEPOINT reject_cross_workspace_delivery_move')

      await client.query('SAVEPOINT reject_foreign_delivery_insert')
      await expect(client.query(`
        INSERT INTO workspace_customer_deliveries
          (id,workspace_id,company_name,created_by_actor_id,updated_by_actor_id)
        VALUES('forged-delivery',$1,'Forged customer','fixture','fixture')`, [workspaceB]))
        .rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK TO SAVEPOINT reject_foreign_delivery_insert')

      await client.query('SAVEPOINT reject_foreign_video_insert')
      await expect(client.query(`
        INSERT INTO workspace_customer_delivery_videos
          (id,workspace_id,delivery_id,title,asset_ref,uploaded_by_actor_id)
        VALUES('forged-video',$1,$2,'Forged video','forged-asset','fixture')`, [workspaceB, deliveryB]))
        .rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK TO SAVEPOINT reject_foreign_video_insert')

      await client.query('SAVEPOINT reject_foreign_checklist_insert')
      await expect(client.query(`
        INSERT INTO workspace_customer_delivery_checklist_items
          (workspace_id,delivery_id,checklist_key,item_key,completed)
        VALUES($1,$2,'system_integration','forged-item',true)`, [workspaceB, deliveryB]))
        .rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK TO SAVEPOINT reject_foreign_checklist_insert')

      // UPDATE against a foreign row is hidden by the policy's USING clause.
      expect((await client.query(`UPDATE workspace_customer_deliveries
        SET company_name='must stay beta' WHERE workspace_id=$1 AND id=$2 RETURNING id`, [workspaceB, deliveryB])).rows)
        .toEqual([])

      await client.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceB])
      expect((await client.query('SELECT id,workspace_id FROM workspace_customer_deliveries ORDER BY id')).rows)
        .toEqual([{ id: deliveryB, workspace_id: workspaceB }])
      expect((await client.query('SELECT id,workspace_id FROM workspace_customer_delivery_videos ORDER BY id')).rows)
        .toEqual([{ id: videoB, workspace_id: workspaceB }])
      expect((await client.query('SELECT delivery_id,item_key FROM workspace_customer_delivery_checklist_items ORDER BY item_key')).rows)
        .toEqual([{ delivery_id: deliveryB, item_key: itemB }])
      await client.query('ROLLBACK')

      expect((await database!.query('SELECT id,company_name FROM workspace_customer_deliveries WHERE id=$1', [deliveryB])).rows)
        .toEqual([{ id: deliveryB, company_name: 'Customer beta' }])
      expect((await database!.query('SELECT id FROM workspace_customer_delivery_videos WHERE id=$1', ['forged-video'])).rows).toEqual([])
      expect((await database!.query('SELECT item_key FROM workspace_customer_delivery_checklist_items WHERE item_key=$1', ['forged-item'])).rows).toEqual([])
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  }, 30_000)
})
