import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'
import { createHash, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

const databaseConnection = (base: URL, database: string) => {
  const url = new URL(base)
  url.pathname = `/${database}`
  return url.toString()
}

describe('migration 204 customer delivery atomic evidence', () => {
  postgresIt('enforces ACL and tenant/purpose/trust bindings and invalidates blocked/deleted evidence once', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `probe_delivery_evidence_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    const database = new Pool({ connectionString: databaseConnection(base, databaseName) })
    const sha = 'a'.repeat(64)

    const addFixture = async (workspaceId: string, deliveryId: string, assetId: string) => {
      const digest = createHash('sha256').update(assetId).digest('hex')
      const receiptId = `receipt_${assetId}`
      const quarantineKey = `quarantine/${workspaceId}/${assetId}/source.pdf`
      const receipt = {
        schema_version: 'asset-scan-receipt/1.0',
        receipt_id: receiptId,
        subject: { workspace_id: workspaceId, asset_id: assetId, asset_source_revision: 1, object_key: quarantineKey, sha256: sha, size_bytes: 4, mime_type: 'application/pdf' },
        scan: { verdict: 'clean' },
      }
      await database.query(`INSERT INTO workspaces (id,status) VALUES ($1,'active')`, [workspaceId])
      await database.query(
        `INSERT INTO asset_scan_receipts (receipt_id,workspace_id,asset_id,asset_source_revision,receipt_digest,signature,verdict,object_key,object_sha256,canonical_payload,receipt)
         VALUES ($1,$2,$3,1,$4,'signature','clean',$5,$6,$7::text,$7::jsonb)`,
        [receiptId, workspaceId, assetId, digest, quarantineKey, sha, JSON.stringify(receipt)],
      )
      const payload = { id: assetId, workspaceId, sourceRevision: 1, scanReceiptId: receiptId, scanReceiptDigest: digest,
        scanVerdict: 'clean', scanStatus: 'clean', storageKey: `clean/${workspaceId}/${assetId}/source.pdf`, mimeType: 'application/pdf',
        sha256: sha, sizeBytes: 4, revision: 1 }
      await database.query(
        `INSERT INTO business_entity_snapshots (workspace_id,entity_type,entity_id,entity_version,payload) VALUES ($1,'asset',$2,1,$3::jsonb)`,
        [workspaceId, assetId, JSON.stringify(payload)],
      )
      const decisionId = `decision_${assetId}`
      await database.query(
        `INSERT INTO platform_authorization_audit (
           id,decision_id,policy_version,actor_id,workbench,capability,method,result,
           reason_code,resource_type,resource_id,resource_scope,request_id,trace_id,evidence
         ) VALUES (gen_random_uuid(),$1,'test-v1','operator','platform','customer.delivery.update',
           'ops.customer-delivery.assets.upload','allow','allowed','platform','*','{}'::jsonb,$2,$3,'{}'::jsonb)`,
        [decisionId, `request_${assetId}`, `trace_${assetId}`],
      )
      await database.query(
        `INSERT INTO outbox_events (id,workspace_id,aggregate_id,event_type,sequence,payload)
         VALUES ($1,$2,$3,'asset.customer_delivery_quarantined',1,$4::jsonb)`,
        [`event_${assetId}`, workspaceId, assetId, JSON.stringify({ asset_id: assetId, source_revision: 1,
          delivery_scan_admission: { schema_version: 1, operation: 'customer_delivery.asset.scan.execute', decision_id: decisionId,
            actor_id: 'operator', workbench: 'platform', context_id: 'platform:global', capability: 'customer.delivery.update', authorized: true,
            workspace_id: workspaceId, delivery_id: deliveryId, purpose: 'payment', asset_id: assetId, source_revision: 1,
            request_id: `request_${assetId}`, trace_id: `trace_${assetId}` } })],
      )
      await database.query(
        `INSERT INTO workspace_customer_deliveries (
           id,workspace_id,company_name,payment_status,payment_date,payment_evidence_refs,
           training_completed,training_evidence_refs,system_integration_status,
           functional_acceptance_status,customer_profile_status,effective_at,
           created_by_actor_id,updated_by_actor_id
         ) VALUES ($1,$2,$3,'paid',DATE '2026-09-14',ARRAY[$4],true,ARRAY[$4],
           'complete','complete','complete',now(),'operator','operator')`,
        [deliveryId, workspaceId, `Company ${deliveryId}`, assetId],
      )
    }

    let primaryFailure: unknown
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      expect(await new MigrationRunner(database, await loadMigrations()).run()).toEqual(expect.arrayContaining([204, 205]))
      await addFixture('ws_evidence_a', 'delivery_a', 'asset_a')
      await addFixture('ws_evidence_b', 'delivery_b', 'asset_b')
      await addFixture('ws_evidence_delete', 'delivery_delete', 'asset_delete')
      await database.query(
        `UPDATE workspace_customer_deliveries SET effective_at=NULL
         WHERE workspace_id='ws_evidence_delete' AND id='delivery_delete'`,
      )

      expect((await database.query(
        `SELECT has_function_privilege('merchant_ops','public.assert_customer_delivery_evidence_asset(text,text,text,text)','EXECUTE') AS ops,
                has_function_privilege('merchant_app','public.assert_customer_delivery_evidence_asset(text,text,text,text)','EXECUTE') AS app`,
      )).rows[0]).toEqual({ ops: true, app: false })

      await database.query('BEGIN')
      await database.query('SET LOCAL ROLE merchant_ops')
      await database.query(`SELECT set_config('app.workspace_id','ws_evidence_a',true)`)
      await expect(database.query(
        `SELECT public.assert_customer_delivery_evidence_asset('ws_evidence_a','delivery_a','payment','asset_a')`,
      )).resolves.toBeDefined()
      await database.query('COMMIT')

      for (const [workspaceId, deliveryId, purpose, assetId, code] of [
        ['ws_evidence_a', 'delivery_a', 'training', 'asset_a', '23514'],
        ['ws_evidence_b', 'delivery_b', 'payment', 'asset_b', '42501'],
      ] as const) {
        await database.query('BEGIN')
        await database.query('SET LOCAL ROLE merchant_ops')
        await database.query(`SELECT set_config('app.workspace_id','ws_evidence_a',true)`)
        await expect(database.query(
          `SELECT public.assert_customer_delivery_evidence_asset($1,$2,$3,$4)`,
          [workspaceId, deliveryId, purpose, assetId],
        )).rejects.toMatchObject({ code })
        await database.query('ROLLBACK')
      }

      const replacementDigest = createHash('sha256').update('asset_b_revision_2').digest('hex')
      const replacementReceipt = {
        schema_version: 'asset-scan-receipt/1.0', receipt_id: 'receipt_asset_b_v2',
        subject: { workspace_id: 'ws_evidence_b', asset_id: 'asset_b', asset_source_revision: 2,
          object_key: 'quarantine/ws_evidence_b/asset_b/source-v2.pdf', sha256: sha, size_bytes: 4, mime_type: 'application/pdf' },
        scan: { verdict: 'clean' },
      }
      await database.query(
        `INSERT INTO asset_scan_receipts (receipt_id,workspace_id,asset_id,asset_source_revision,receipt_digest,signature,verdict,object_key,object_sha256,canonical_payload,receipt)
         VALUES ('receipt_asset_b_v2','ws_evidence_b','asset_b',2,$1,'signature-v2','clean','quarantine/ws_evidence_b/asset_b/source-v2.pdf',$2,$3::text,$3::jsonb)`,
        [replacementDigest, sha, JSON.stringify(replacementReceipt)],
      )
      await database.query(
        `UPDATE business_entity_snapshots
         SET payload = payload || $1::jsonb, entity_version=entity_version+1
         WHERE workspace_id='ws_evidence_b' AND entity_type='asset' AND entity_id='asset_b'`,
        [JSON.stringify({ sourceRevision: 2, scanReceiptId: 'receipt_asset_b_v2', scanReceiptDigest: replacementDigest,
          storageKey: 'clean/ws_evidence_b/asset_b/source-v2.pdf' })],
      )
      expect((await database.query(
        `SELECT effective_at,revision FROM workspace_customer_deliveries
         WHERE workspace_id='ws_evidence_b' AND id='delivery_b'`,
      )).rows).toEqual([{ effective_at: null, revision: '2' }])
      expect((await database.query(
        `SELECT count(*)::int AS count FROM workspace_operation_audit
         WHERE workspace_id='ws_evidence_b' AND action='customer_delivery.evidence.invalidated'`,
      )).rows).toEqual([{ count: 1 }])

      const attachment = await database.connect()
      const concurrentDowngrade = await database.connect()
      try {
        await attachment.query('BEGIN')
        await attachment.query('SET LOCAL ROLE merchant_ops')
        await attachment.query(`SELECT set_config('app.workspace_id','ws_evidence_a',true)`)
        await attachment.query(
          `SELECT public.assert_customer_delivery_evidence_asset('ws_evidence_a','delivery_a','payment','asset_a')`,
        )
        await concurrentDowngrade.query(`SET statement_timeout='100ms'`)
        await expect(concurrentDowngrade.query(
          `UPDATE business_entity_snapshots
           SET payload=jsonb_set(payload,'{scanStatus}','"blocked"'::jsonb,true), entity_version=entity_version+1
           WHERE workspace_id='ws_evidence_a' AND entity_type='asset' AND entity_id='asset_a'`,
        )).rejects.toMatchObject({ code: '57014' })
        await attachment.query('COMMIT')
      } finally {
        await attachment.query('ROLLBACK').catch(() => undefined)
        await concurrentDowngrade.query('RESET statement_timeout').catch(() => undefined)
        attachment.release()
        concurrentDowngrade.release()
      }

      await database.query(
        `UPDATE business_entity_snapshots
         SET payload=jsonb_set(payload,'{scanStatus}','"blocked"'::jsonb,true), entity_version=entity_version+1
         WHERE workspace_id='ws_evidence_a' AND entity_type='asset' AND entity_id='asset_a'`,
      )
      const blocked = (await database.query(
        `SELECT effective_at,revision,payment_status,training_completed,system_integration_status,functional_acceptance_status
         FROM workspace_customer_deliveries WHERE workspace_id='ws_evidence_a' AND id='delivery_a'`,
      )).rows[0]
      expect(blocked).toMatchObject({ effective_at: null, revision: '2', payment_status: 'paid', training_completed: true,
        system_integration_status: 'complete', functional_acceptance_status: 'complete' })
      expect((await database.query(
        `SELECT count(*)::int AS count FROM workspace_operation_audit
         WHERE workspace_id='ws_evidence_a' AND action='customer_delivery.evidence.invalidated'`,
      )).rows).toEqual([{ count: 1 }])

      await database.query(
        `UPDATE business_entity_snapshots SET payload=jsonb_set(payload,'{revision}','2'::jsonb,true)
         WHERE workspace_id='ws_evidence_a' AND entity_type='asset' AND entity_id='asset_a'`,
      )
      await database.query(
        `DELETE FROM business_entity_snapshots WHERE workspace_id='ws_evidence_a' AND entity_type='asset' AND entity_id='asset_a'`,
      )
      expect((await database.query(
        `SELECT revision FROM workspace_customer_deliveries WHERE workspace_id='ws_evidence_a' AND id='delivery_a'`,
      )).rows).toEqual([{ revision: '2' }])
      expect((await database.query(
        `SELECT count(*)::int AS count FROM workspace_operation_audit
         WHERE workspace_id='ws_evidence_a' AND action='customer_delivery.evidence.invalidated'`,
      )).rows).toEqual([{ count: 1 }])

      await database.query(
        `DELETE FROM business_entity_snapshots
         WHERE workspace_id='ws_evidence_delete' AND entity_type='asset' AND entity_id='asset_delete'`,
      )
      expect((await database.query(
        `SELECT effective_at,revision,training_completed FROM workspace_customer_deliveries
         WHERE workspace_id='ws_evidence_delete' AND id='delivery_delete'`,
      )).rows).toEqual([{ effective_at: null, revision: '2', training_completed: true }])
      expect((await database.query(
        `SELECT after_json->>'asset_scan_status' AS status FROM workspace_operation_audit
         WHERE workspace_id='ws_evidence_delete' AND action='customer_delivery.evidence.invalidated'`,
      )).rows).toEqual([{ status: 'deleted' }])
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      await withPostgresFixtureCleanup(async () => {
        await database.end()
        await dropDrainedPostgresFixture(admin, databaseName)
      }, primaryFailure, [
        () => admin.end(),
      ])
    }
  }, 300_000)
})
