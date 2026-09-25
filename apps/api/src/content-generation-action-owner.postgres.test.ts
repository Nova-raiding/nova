import { createHash, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { PostgresActionLedgerRepository } from '../../../packages/persistence/src/action-ledger-repository.js'
import { PostgresChargedTextDispatchRepository } from '../../../packages/persistence/src/charged-text-dispatch-repository.js'
import { PostgresCreativePointLifecycleRepository } from '../../../packages/persistence/src/creative-point-lifecycle-repository.js'
import { loadMigrations, MigrationRunner } from '../../../packages/persistence/src/migration.js'
import { PostgresModelUsageRepository } from '../../../packages/persistence/src/model-usage-repository.js'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from '../../../packages/persistence/src/postgres-scope-fixture-cleanup.js'

const baseUrl = process.env.PERSISTENCE_RELEASE_DATABASE_URL
if (!baseUrl) throw new Error('PERSISTENCE_RELEASE_DATABASE_URL is required for PostgreSQL action ownership acceptance')

describe('content.generate action ownership over HTTP and PostgreSQL', () => {
  it('binds one durable job and preserves its hold when a concurrent request replays its action', async () => {
    const name = `probe_authz_reservation_acl_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: baseUrl })
    const isolatedUrl = new URL(baseUrl)
    isolatedUrl.pathname = `/${name}`
    let database: Pool | undefined
    let api: typeof import('./server.js') | undefined
    let primaryFailure: unknown
    try {
      await admin.query(`CREATE DATABASE "${name}"`)
      database = new Pool({ connectionString: isolatedUrl.toString() })
      await new MigrationRunner(database, await loadMigrations()).run()

      const workspaceId = `ws_content_owner_${randomUUID().replaceAll('-', '').slice(0, 12)}`
      await database.query('INSERT INTO workspaces(id,status) VALUES ($1,$2)', [workspaceId, 'active'])
      await database.query("INSERT INTO workspaces(id,status) VALUES ('ws_demo','active')")
      const fixtureId = randomUUID().replaceAll('-', '')
      const skuId = `sku_${fixtureId}`
      const versionId = `sku_version_${fixtureId}`
      const orderId = `order_${fixtureId}`
      const orderSnapshotId = `order_snapshot_${fixtureId}`
      const periodId = `period_${fixtureId}`
      await database.query('INSERT INTO commercial_catalog_skus(id,code,kind,visibility) VALUES ($1,$2,$3,$4)', [skuId, `monthly_${fixtureId}`, 'monthly', 'public'])
      await database.query("INSERT INTO commercial_catalog_sku_versions(id,sku_id,version,lifecycle,executable,price_fen,currency,price_mode,payload,checksum,effective_at) VALUES ($1,$2,1,'approved',true,100,'CNY','fixed','{}'::jsonb,$3,now())", [versionId, skuId, 'a'.repeat(64)])
      await database.query("INSERT INTO commercial_orders_v2(id,workspace_id,sku_id,sku_version_id,amount_fen,currency,payment_provider,status,idempotency_key,request_hash,created_by_actor_id,paid_at) VALUES ($1,$2,$3,$4,100,'CNY','fixture','paid',$5,$6,'content-owner',now())", [orderId, workspaceId, skuId, versionId, `order-${fixtureId}`, 'b'.repeat(64)])
      await database.query("INSERT INTO commercial_order_snapshots_v2(id,workspace_id,order_id,sku_id,sku_version_id,catalog_checksum,snapshot,checksum) VALUES ($1,$2,$3,$4,$5,$6,'{}'::jsonb,$7)", [orderSnapshotId, workspaceId, orderId, skuId, versionId, 'a'.repeat(64), 'c'.repeat(64)])
      await database.query("INSERT INTO workspace_subscription_periods_v2(id,workspace_id,order_snapshot_id,period_start,period_end,status,revision) VALUES ($1,$2,$3,now() - interval '1 day',now() + interval '30 days','active',1)", [periodId, workspaceId, orderSnapshotId])
      await database.query("INSERT INTO workspace_entitlement_snapshots_v2(id,workspace_id,subscription_period_id,subscription_period_revision,catalog_version_id,resolved_benefits,unresolved_blockers,executable,checksum) VALUES ($1,$2,$3,1,$4,$5::jsonb,'[]'::jsonb,true,$6)", [`entitlement_${fixtureId}`, workspaceId, periodId, versionId, JSON.stringify([{ code: 'max_brands', quantity: 1 }, { code: 'max_stores', quantity: 5 }]), 'd'.repeat(64)])
      vi.stubEnv('NODE_ENV', 'development')
      vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
      vi.stubEnv('SESSION_ID_HASH_SECRET', 'content-generation-owner-pg-e2e-session-secret')
      vi.stubEnv('DATABASE_URL', isolatedUrl.toString())
      vi.stubEnv('RUN_MIGRATIONS_ON_STARTUP', 'false')
      vi.stubEnv('PERSISTENCE_MODE', 'postgres')
      vi.stubEnv('LOCAL_COMPOSE', 'true')
      vi.stubEnv('CONNECTOR_FIXTURE_MODE', 'true')
      vi.stubEnv('MERCHANT_TEST_APPROVED_RATES', 'true')
      vi.stubEnv('API_BIND_HOST', '127.0.0.1')
      vi.stubEnv('PORT', '0')
      vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
        'content-owner-token': { workspaces: [workspaceId], actor_id: 'content-owner', roles: ['workspace_owner'], workbenches: ['workspace'] },
        'finance-ops-token': { workspaces: [workspaceId], actor_id: 'finance-operator', roles: ['finance_ops'], workbenches: ['platform'] },
      }))
      api = await import('./server.js')
      await api.persistenceReady
      if (!api.server.listening) await new Promise<void>((resolve, reject) => {
        api!.server.once('listening', resolve)
        api!.server.once('error', reject)
      })

      await api.workspaceMembers.upsert({ workspaceId, externalSubject: 'content-owner', displayName: 'Content Owner', role: 'workspace_owner', status: 'active', invitedBy: 'content-owner-postgres-e2e' })
      await (await api.persistenceReady).members!.upsert({ workspaceId, externalSubject: 'content-owner', displayName: 'Content Owner', role: 'workspace_owner', status: 'active', invitedBy: 'content-owner-postgres-e2e' })
      await api.grantCreativePointsForTests(workspaceId)
      api.grantContinuousFeatureEntitlementForTests(workspaceId)
      const account = api.service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: 'content-owner-shop', credentialRef: 'vault://content-owner-test/taobao' })
      const product = api.service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, localProductKey: 'content-owner-product', title: '并发回归商品', stock: 10 })
      api.service.confirmProductFacts(workspaceId, product.id)
      const task = api.service.createTask({ workspaceId, productId: product.id, platform: 'taobao', accountId: account.id, requestText: '生成商品内容' })
      api.service.selectDirection(task.id, 'A')
      api.service.confirmProductionPlan(workspaceId, task.id, 'content-owner')
      await database.query('INSERT INTO platform_accounts(id,workspace_id,platform,remote_account_id,credential_ref,token_state) VALUES ($1,$2,$3,$4,$5,$6)', [account.id, workspaceId, 'taobao', 'content-owner-shop', 'vault://content-owner-test/taobao', 'active'])
      await database.query("INSERT INTO products(id,workspace_id,platform,platform_account_id,remote_product_id,title,sku_count,stock,facts_confirmed,source,data) VALUES ($1,$2,'taobao',$3,$4,$5,1,10,true,'fixture',$6::jsonb)", [product.id, workspaceId, account.id, 'content-owner-product', product.title, JSON.stringify(product)])
      await database.query("INSERT INTO tasks(id,workspace_id,product_id,platform,platform_account_id,state,selected_direction_id,version,data) VALUES ($1,$2,$3,'taobao',$4,'plan_confirmed','A',$5,$6::jsonb)", [task.id, workspaceId, product.id, account.id, api.service.getTask(task.id).version, JSON.stringify(api.service.getTask(task.id))])
      const address = api.server.address()
      if (!address || typeof address === 'string') throw new Error('API did not bind TCP')
      const request = (id: number, targetTaskId = task.id, key = 'same-client-action') => fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: 'POST',
        headers: { authorization: 'Bearer content-owner-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'idempotency-key': key, 'x-test-commercial-fixture': 'server-e2e' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'content.generate', params: { workspace_id: workspaceId, task_id: targetTaskId, idempotency_key: key } }),
      }).then(async response => ({ status: response.status, body: await response.json() as { error?: { code?: string } | null; data?: { result?: { id?: string } } | null } }))
      const resolveNoDelivery = (id: number, token: string, revision = '1', evidenceRef = 'finance-case-253') => fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-ops-workbench': token === 'finance-ops-token' ? 'platform' : 'workspace' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'ops.marketing.generation.no_delivery.refund', params: {
          workspace_id: workspaceId, action_key: 'model:generation:same-client-action', job_revision: revision,
          reason: '模型响应无可交付内容，核实回执后退回创意点', evidence_ref: evidenceRef,
        } }),
      }).then(async response => ({ status: response.status, body: await response.json() as { error?: { code?: string } | null; data?: { result?: Record<string, unknown> } | null } }))

      // The action-owner path starts after a frozen context has been prepared.
      // This fixture creates the task in the in-process service, so it supplies
      // a frozen context reference instead of exercising the separate context
      // snapshot FK path, which has its own PostgreSQL tests.
      const prepared = {
        task,
        product,
        input: { platform: 'taobao', directionId: 'A', product: { id: product.id, title: product.title, stock: product.stock, skuCount: 1, skuIds: [] }, confirmedFactSourceIds: [`product:${product.id}:v1`], usageContext: { workspaceId, actionId: 'model:generation:same-client-action', runKey: task.id } },
        inputTokensEstimate: 30,
        maxInputTokens: 4000,
        contextRef: { id: `ctx_${fixtureId}`, contextHash: 'e'.repeat(64) },
      } as unknown as Awaited<ReturnType<typeof api.service.prepareGenerationContext>>
      const prepare = vi.spyOn(api.service, 'prepareGenerationContext').mockResolvedValue(prepared)
      const pointRepository = (await api.persistenceReady).creativePoints!
      const realReserve = pointRepository.reserve.bind(pointRepository)
      let entered!: () => void
      let continueOwner!: () => void
      const ownerReserved = new Promise<void>(resolve => { entered = resolve })
      const ownerGate = new Promise<void>(resolve => { continueOwner = resolve })
      const reserve = vi.spyOn(pointRepository, 'reserve').mockImplementation(async input => {
        const result = await realReserve(input)
        entered()
        await ownerGate
        return result
      })
      const owner = request(1)
      try {
        await Promise.race([ownerReserved, owner.then(result => { throw new Error(`owner returned before reservation: ${JSON.stringify(result)}`) })])
        const replay = await request(2)
        expect(replay.status).toBe(409)
        expect(replay.body.error?.code).toBe('CREATIVE_ACTION_BUSY')
        const reservations = await database.query<{ status: string; action_key: string }>(
          'SELECT status,action_key FROM creative_point_reservations WHERE workspace_id=$1 AND action_key=$2',
          [workspaceId, 'model:generation:same-client-action'],
        )
        expect(reservations.rows).toEqual([{ status: 'active', action_key: 'model:generation:same-client-action' }])
        expect(reserve).toHaveBeenCalledTimes(1)
      } finally {
        continueOwner()
      }
      try {
        const created = await owner
        expect(created.status, JSON.stringify(created.body)).toBe(200)
        expect(created.body.error).toBeNull()
        const jobId = created.body.data?.result?.id
        expect(jobId).toEqual(expect.any(String))
        const replay = await request(3)
        expect(replay.status, JSON.stringify(replay.body)).toBe(200)
        expect(replay.body.data?.result?.id).toBe(jobId)
        const claim = await database.query<{ phase: string; reservation_id: string; job_id: string; event_id: string }>(
          'SELECT phase,reservation_id,job_id,event_id FROM creative_point_action_claims WHERE workspace_id=$1 AND action_key=$2',
          [workspaceId, 'model:generation:same-client-action'],
        )
        expect(claim.rows).toHaveLength(1)
        expect(claim.rows[0]).toMatchObject({ phase: 'bound', job_id: jobId, reservation_id: expect.any(String), event_id: expect.any(String) })
        const reservations = await database.query<{ id: string; status: string }>(
          'SELECT id,status FROM creative_point_reservations WHERE workspace_id=$1 AND action_key=$2',
          [workspaceId, 'model:generation:same-client-action'],
        )
        expect(reservations.rows).toEqual([{ id: claim.rows[0]!.reservation_id, status: 'active' }])
        const jobs = await database.query<{ entity_id: string }>(
          "SELECT entity_id FROM business_entity_snapshots WHERE workspace_id=$1 AND entity_type='generation_job' AND entity_id=$2",
          [workspaceId, jobId],
        )
        expect(jobs.rows).toEqual([{ entity_id: jobId }])
        const events = await database.query<{ id: string }>(
          "SELECT id FROM outbox_events WHERE workspace_id=$1 AND aggregate_id=$2 AND event_type='generation.requested'",
          [workspaceId, jobId],
        )
        expect(events.rows).toEqual([{ id: claim.rows[0]!.event_id }])

        const foreignWorkspace = `ws_foreign_${fixtureId.slice(0, 12)}`
        const foreignBrand = `brand_foreign_${fixtureId}`
        await database.query('INSERT INTO workspaces(id,status) VALUES ($1,$2)', [foreignWorkspace, 'active'])
        await database.query('INSERT INTO brands(id,workspace_id,name) VALUES ($1,$2,$3)', [foreignBrand, foreignWorkspace, 'Foreign brand'])
        const foreignTask = api.service.createTask({ workspaceId, productId: product.id, platform: 'taobao', accountId: account.id, brandId: foreignBrand, requestText: '越租户品牌任务' })
        api.service.selectDirection(foreignTask.id, 'A')
        api.service.confirmProductionPlan(workspaceId, foreignTask.id, 'content-owner')
        await database.query("INSERT INTO tasks(id,workspace_id,product_id,platform,platform_account_id,state,selected_direction_id,version,data) VALUES ($1,$2,$3,'taobao',$4,'plan_confirmed','A',$5,$6::jsonb)", [foreignTask.id, workspaceId, product.id, account.id, api.service.getTask(foreignTask.id).version, JSON.stringify(api.service.getTask(foreignTask.id))])
        const denied = await request(4, foreignTask.id, 'foreign-brand-action')
        expect(denied.status, JSON.stringify(denied.body)).toBe(409)
        expect(denied.body.error?.code).toBe('TASK_BRAND_SCOPE_MISMATCH')
        const leakedEvents = await database.query<{ id: string }>(
          "SELECT id FROM outbox_events WHERE workspace_id=$1 AND event_type='generation.requested' AND payload->>'task_id'=$2",
          [workspaceId, foreignTask.id],
        )
        expect(leakedEvents.rows).toHaveLength(0)

        const merchantDenied = await resolveNoDelivery(5, 'content-owner-token')
        expect(merchantDenied.status).toBe(403)
        const activeHold = await resolveNoDelivery(6, 'finance-ops-token')
        expect(activeHold.status, JSON.stringify(activeHold.body)).toBe(409)
        expect(activeHold.body.error?.code).toBe('CHARGED_TEXT_NO_DELIVERY_EVIDENCE_MISMATCH')
        expect((await resolveNoDelivery(7, 'finance-ops-token')).body.error?.code).toBe('CHARGED_TEXT_NO_DELIVERY_EVIDENCE_MISMATCH')
        expect((await database.query('SELECT action_key FROM charged_text_no_delivery_resolutions WHERE workspace_id=$1', [workspaceId])).rows).toHaveLength(0)

        const providerId = `provider_${fixtureId}`
        const actionKey = 'model:generation:same-client-action'
        const dispatch = new PostgresChargedTextDispatchRepository(database)
        const physical = await dispatch.claim({ workspaceId, actionKey, eventId: claim.rows[0]!.event_id,
          logicalAttempt: 1, transportAttempt: 1, providerAttemptKey: `mm-${'a'.repeat(64)}`, requestBodySha256: 'b'.repeat(64) })
        await dispatch.transition({ workspaceId, id: physical.id, ownerToken: physical.ownerToken, to: 'provider_started' })
        await dispatch.transition({ workspaceId, id: physical.id, ownerToken: physical.ownerToken, to: 'response_recorded', providerRequestId: providerId })
        await dispatch.transition({ workspaceId, id: physical.id, ownerToken: physical.ownerToken, to: 'completed' })
        await database.query('UPDATE outbox_events SET unknown_at=now(),last_error=$1::jsonb WHERE id=$2', [JSON.stringify({ code: 'CHARGED_TEXT_SCHEMA_REPAIR_DISABLED' }), claim.rows[0]!.event_id])
        expect((await resolveNoDelivery(8, 'finance-ops-token', '1', 'forged-provider-id')).body.error?.code).toBe('CHARGED_TEXT_NO_DELIVERY_EVIDENCE_MISMATCH')

        const reservation = await database.query<{ operation_id: string; points: number }>('SELECT operation_id,points FROM creative_point_reservations WHERE id=$1', [claim.rows[0]!.reservation_id])
        const actionLedger = new PostgresActionLedgerRepository(database)
        await actionLedger.record({ workspaceId, actionKey, actionKind: 'model_text', settlement: 'wallet', units: 1,
          amountFen: 10, actorId: 'fixture', description: 'fixture', settlementStatus: 'authorized' })
        await actionLedger.settleProviderUsage({ workspaceId, actionKey, providerRequestId: providerId, actualAmountFen: 10 })
        const usage = { modality: 'text', model: 'fixture-model', input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        const cost = { currency: 'CNY', actual: 0.1 }
        await new PostgresModelUsageRepository(database).record({ workspaceId, actionId: actionKey, modality: 'text', model: 'fixture-model', providerRequestId: providerId,
          inputTokens: 1, outputTokens: 1, totalTokens: 2, costCny: 0.1, customerChargeCny: 0.1, markupMultiplier: 1,
          pricingPolicyRevision: 1, settlementStatus: 'settled' })
        const observedAt = new Date().toISOString()
        const receiptHash = createHash('sha256').update(JSON.stringify({ providerRequestId: providerId, usage, cost, observedAt })).digest('hex')
        const lifecycle = new PostgresCreativePointLifecycleRepository(database)
        await lifecycle.recordProviderReceipt({ workspaceId, operationId: reservation.rows[0]!.operation_id, provider: 'model-relay', providerRequestId: providerId,
          outcome: 'succeeded', usage, cost, receiptHash, verifiedAt: observedAt, at: observedAt })
        await lifecycle.recordProviderReceipt({ workspaceId, operationId: reservation.rows[0]!.operation_id, provider: 'fixture-relay', providerRequestId: providerId,
          outcome: 'succeeded', usage, cost, receiptHash: 'c'.repeat(64), verifiedAt: observedAt, at: observedAt })
        await pointRepository.settle({ workspaceId, reservationId: claim.rows[0]!.reservation_id, idempotencyKey: `commercial.settle:${actionKey}`,
          actualPoints: Number(reservation.rows[0]!.points), metadata: { provider_request_id: providerId, receipt_hash: receiptHash, cost_cny: 0.1, modality: 'text' } })
        const resolved = await resolveNoDelivery(9, 'finance-ops-token')
        expect(resolved.status, JSON.stringify(resolved.body)).toBe(200)
        expect(resolved.body.data?.result).toMatchObject({ decision: 'refund_no_deliverable', action_key: actionKey,
          job_id: jobId, event_id: claim.rows[0]!.event_id, reservation_id: claim.rows[0]!.reservation_id,
          refunded_points: Number(reservation.rows[0]!.points), provider_request_id: providerId })
        const replayedResolution = await resolveNoDelivery(10, 'finance-ops-token')
        expect(replayedResolution.status, JSON.stringify(replayedResolution.body)).toBe(200)
        expect(replayedResolution.body.data?.result).toEqual(resolved.body.data?.result)
        const resolutionFacts = await database.query<{ reversals: string; audits: string; resolutions: string; job_state: string }>(
          "SELECT (SELECT count(*) FROM creative_point_reversals_v2 WHERE original_reservation_id=$1) AS reversals,(SELECT count(*) FROM workspace_operation_audit WHERE workspace_id=$2 AND action='ops.marketing.generation.no_delivery.refund' AND resource_id=$3) AS audits,(SELECT count(*) FROM charged_text_no_delivery_resolutions WHERE workspace_id=$2 AND action_key=$4) AS resolutions,(SELECT state FROM generation_jobs WHERE id=$3) AS job_state",
          [claim.rows[0]!.reservation_id, workspaceId, jobId, actionKey],
        )
        expect(resolutionFacts.rows[0]).toMatchObject({ reversals: '1', audits: '1', resolutions: '1', job_state: 'failed' })
      } finally {
        reserve.mockRestore()
        prepare.mockRestore()
      }
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      if (api?.server.listening) await new Promise<void>(resolve => api!.server.close(() => resolve()))
      await (await api?.persistenceReady)?.close?.()
      vi.unstubAllEnvs()
      await withPostgresFixtureCleanup(async () => {
        await database?.end()
        await dropDrainedPostgresFixture(admin, name)
      }, primaryFailure, [() => admin.end()])
    }
  }, 240_000)
})
