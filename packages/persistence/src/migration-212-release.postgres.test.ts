import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresCustomerDeliveryRepository } from './customer-delivery-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

const connection = (base: URL, database: string, user?: string, password?: string) => {
  const url = new URL(base)
  url.pathname = `/${database}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

async function scoped<T>(pool: Pool, workspaceId: string, work: (client: PoolClient) => Promise<T>, platformScope = true) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId])
    if (platformScope) await client.query("SET LOCAL app.platform_scope='platform_ops'")
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

describe('migration 212 customer delivery account binding release acceptance', () => {
  postgresIt('preserves history and enforces scoped, immutable, atomic account bindings under concurrent revocation', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_212_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let ops: Pool | undefined
    let app: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: connection(base, databaseName), max: 4 })
      const fixtureDb = database
      const migrations = (await loadMigrations()).filter(migration => migration.version <= 215)
      await new MigrationRunner(database, migrations.filter(migration => migration.version < 215)).run()

      const workspaceId = `delivery-212-${randomUUID()}`
      const otherWorkspaceId = `delivery-212-other-${randomUUID()}`
      await database.query("INSERT INTO workspaces(id,status) VALUES($1,'active'),($2,'active')", [workspaceId, otherWorkspaceId])
      // Administrative writes below create fixtures and simulate lifecycle changes;
      // every successful binding and RLS assertion uses the real merchant_ops role.
      const principal = async (workspaceIds = [workspaceId]) => {
        const identityId = randomUUID()
        const accountId = randomUUID()
        const login = `delivery-${accountId}@example.test`
        await fixtureDb.query(
          `INSERT INTO platform_identities(id,issuer,external_subject,display_name,access_status,risk_decision)
           VALUES($1,'release-212',$2,'Delivery principal','active','allow')`, [identityId, login],
        )
        for (const memberWorkspace of workspaceIds) {
          await fixtureDb.query(
            `INSERT INTO workspace_members(id,workspace_id,external_subject,display_name,role,status,invited_by,identity_id)
             VALUES($1,$2,$3,'Delivery principal','workspace_owner','active','release-212',$4)`,
            [randomUUID(), memberWorkspace, login, identityId],
          )
        }
        await fixtureDb.query(
          `INSERT INTO platform_password_accounts(id,identity_id,login_identifier,account_type,enterprise_name,
             contact_name,password_hash,terms_agreed_at,status,workspace_ids)
           VALUES($1,$2,$3,'merchant','Matching historical company','Delivery principal','$argon2id$acceptance',now(),'active',$4::text[])`,
          [accountId, identityId, login, workspaceIds],
        )
        return { accountId, identityId, login }
      }
      const target = await principal([workspaceId, otherWorkspaceId])
      const alternate = await principal()
      const historicalId = `historical-${randomUUID()}`
      await database.query(
        `INSERT INTO workspace_customer_deliveries(id,workspace_id,company_name,contract_number,project_owner,revision,
           created_by_actor_id,updated_by_actor_id)
         VALUES($1,$2,'Matching historical company','LEGACY-212','Historical owner',7,'historical-creator','historical-updater')`,
        [historicalId, workspaceId],
      )
      const historicalBefore = (await database.query('SELECT to_jsonb(d) AS row FROM workspace_customer_deliveries d WHERE id=$1', [historicalId])).rows[0].row
      const auditCountBefore = (await database.query('SELECT count(*)::integer AS count FROM workspace_operation_audit')).rows[0].count
      expect(await new MigrationRunner(database, migrations).run()).toEqual([215])
      expect(await new MigrationRunner(database, migrations).run()).toEqual([])
      const historicalAfter = (await database.query(
        `SELECT to_jsonb(d)-'target_account_id'-'target_identity_id' AS row,target_account_id,target_identity_id
         FROM workspace_customer_deliveries d WHERE id=$1`, [historicalId],
      )).rows[0]
      expect(historicalAfter).toEqual({ row: historicalBefore, target_account_id: null, target_identity_id: null })
      expect((await database.query('SELECT count(*)::integer AS count FROM workspace_operation_audit')).rows[0].count).toBe(auditCountBefore)

      ops = new Pool({ connectionString: connection(base, databaseName, 'merchant_ops', 'merchant_ops_local_only'), max: 4 })
      app = new Pool({ connectionString: connection(base, databaseName, 'merchant_app', 'merchant_app_local_only'), max: 1 })
      const opsPool = ops
      const repo = new PostgresCustomerDeliveryRepository(ops)
      expect((await ops.query('SELECT current_user AS role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows)
        .toEqual([{ role: 'merchant_ops', rolsuper: false, rolbypassrls: false }])
      const lockTarget = (client: PoolClient, accountId = target.accountId, workspace = workspaceId) => client.query(
        'SELECT * FROM public.lock_customer_delivery_account_target($1,$2::uuid)', [workspace, accountId],
      )
      await expect(scoped(app, workspaceId, client => lockTarget(client))).rejects.toMatchObject({ code: '42501' })
      await expect(app.query('SELECT id FROM workspace_customer_deliveries')).rejects.toMatchObject({ code: '42501' })
      // The merchant-facing API must use its controlled Ops repository. A
      // merchant_app repository cannot read deliveries even when none are bound.
      const appRepo = new PostgresCustomerDeliveryRepository(app)
      await expect(appRepo.getByIdentity(workspaceId, target.identityId)).rejects.toMatchObject({ code: '42501' })

      await expect(ops.query('SELECT * FROM public.lock_customer_delivery_account_target($1,$2::uuid)', [workspaceId, target.accountId]))
        .rejects.toMatchObject({ code: '42501' })
      await expect(scoped(ops, workspaceId, client => lockTarget(client), false)).rejects.toMatchObject({ code: '42501' })
      await expect(scoped(ops, otherWorkspaceId, client => lockTarget(client))).rejects.toMatchObject({ code: '42501' })
      expect((await ops.query('SELECT id FROM workspace_customer_deliveries')).rows).toEqual([])
      expect((await scoped(ops, otherWorkspaceId, client => client.query(
        'SELECT id FROM workspace_customer_deliveries WHERE id=$1', [historicalId],
      ))).rows).toEqual([])
      expect((await scoped(ops, otherWorkspaceId, client => client.query(
        'UPDATE workspace_customer_deliveries SET company_name=$2 WHERE id=$1', [historicalId, 'Cross-workspace attempt'],
      ))).rowCount).toBe(0)
      await expect(scoped(ops, otherWorkspaceId, client => client.query(
        `INSERT INTO workspace_customer_deliveries(id,workspace_id,company_name,created_by_actor_id,updated_by_actor_id)
         VALUES($1,$2,'Wrong scope','release-212','release-212')`, [randomUUID(), workspaceId],
      ))).rejects.toMatchObject({ code: '42501' })

      const firstPage = await repo.listBindableAccounts({ workspaceId, search: 'delivery-', limit: 1 })
      expect(firstPage.items).toHaveLength(1)
      expect(firstPage.nextCursor).toEqual(expect.any(String))
      const secondPage = await repo.listBindableAccounts({ workspaceId, search: 'delivery-', limit: 1, cursor: firstPage.nextCursor! })
      expect(secondPage.items).toHaveLength(1)
      expect(secondPage.nextCursor).toBeUndefined()
      expect(secondPage.items[0]!.accountId).not.toBe(firstPage.items[0]!.accountId)
      expect([...firstPage.items, ...secondPage.items].map(account => account.accountId).sort())
        .toEqual([target.accountId, alternate.accountId].sort())
      expect([...firstPage.items, ...secondPage.items].every(account => account.workspaceId === workspaceId)).toBe(true)
      expect((await repo.listBindableAccounts({ workspaceId: otherWorkspaceId, limit: 1 })).items)
        .toEqual([{ workspaceId: otherWorkspaceId, accountId: target.accountId, identityId: target.identityId, login: target.login }])
      await expect(repo.listBindableAccounts({ workspaceId: otherWorkspaceId, search: 'delivery-', limit: 1, cursor: firstPage.nextCursor! }))
        .rejects.toMatchObject({ code: 'INVALID_INPUT' })

      const bindInput = { workspaceId, deliveryId: historicalId, targetAccountId: target.accountId,
        actorId: 'release-212-operator', expectedRevision: 7, reason: '  Verified merchant login  ' }
      await expect(repo.bindAccount({ ...bindInput, expectedRevision: 6 })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
      const bound = await repo.bindAccount(bindInput)
      expect(bound).toMatchObject({ id: historicalId, targetAccountId: target.accountId, targetIdentityId: target.identityId,
        targetAccountLogin: target.login, revision: 8, updatedByActorId: bindInput.actorId, paymentStatus: 'unpaid', effectiveAt: null })
      expect(await repo.getByIdentity(workspaceId, target.identityId)).toMatchObject({ id: historicalId, revision: 8 })
      await expect(appRepo.getByIdentity(workspaceId, target.identityId)).rejects.toMatchObject({ code: '42501' })
      expect(await repo.getByIdentity(workspaceId, alternate.identityId)).toBeNull()
      expect(await repo.getByIdentity(otherWorkspaceId, target.identityId)).toBeNull()
      const remainingAccounts = await repo.listBindableAccounts({ workspaceId, limit: 1 })
      expect(remainingAccounts.items.map(account => account.identityId)).toEqual([alternate.identityId])
      expect(remainingAccounts.nextCursor).toBeUndefined()
      const bindingAudits = async (deliveryId: string) => (await fixtureDb.query(
        `SELECT actor_id,reason,before_json,after_json FROM workspace_operation_audit
         WHERE action='customer_delivery.account.bind' AND resource_id=$1 ORDER BY created_at,id`, [deliveryId],
      )).rows
      const audits = await bindingAudits(historicalId)
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({ actor_id: bindInput.actorId, reason: bindInput.reason.trim(),
        before_json: { targetAccountId: null, targetIdentityId: null, revision: 7 },
        after_json: { targetAccountId: target.accountId, targetIdentityId: target.identityId, revision: 8 } })
      expect(JSON.stringify(audits)).not.toMatch(/password_hash|passwordHash|argon2id|token_hash/u)

      const create = (companyName: string, workspace = workspaceId) => repo.create({ workspaceId: workspace, companyName, actorId: 'release-212-operator' })
      const duplicate = await create('Duplicate identity')
      await expect(repo.bindAccount({ ...bindInput, deliveryId: duplicate.id, expectedRevision: duplicate.revision }))
        .rejects.toMatchObject({ code: 'ACCOUNT_ALREADY_BOUND' })
      await expect(repo.bindAccount({ ...bindInput, expectedRevision: 8, targetAccountId: alternate.accountId }))
        .rejects.toMatchObject({ code: 'ACCOUNT_ALREADY_BOUND' })
      expect(await bindingAudits(duplicate.id)).toEqual([])
      expect((await repo.get(workspaceId, duplicate.id))?.targetAccountId).toBeNull()
      for (const update of [
        { sql: 'target_account_id=NULL,target_identity_id=NULL', values: [] },
        { sql: 'target_account_id=$2,target_identity_id=$3', values: [alternate.accountId, alternate.identityId] },
        { sql: 'workspace_id=$2', values: [otherWorkspaceId] },
      ]) {
        await expect(scoped(ops, workspaceId, client => client.query(
          `UPDATE workspace_customer_deliveries SET ${update.sql} WHERE id=$1`, [historicalId, ...update.values],
        ))).rejects.toMatchObject({ code: '23514', message: 'customer delivery account binding is immutable' })
      }
      const otherDelivery = await create('Same identity in another workspace', otherWorkspaceId)
      expect(await repo.bindAccount({ ...bindInput, workspaceId: otherWorkspaceId, deliveryId: otherDelivery.id, expectedRevision: otherDelivery.revision }))
        .toMatchObject({ targetAccountId: target.accountId, targetIdentityId: target.identityId })
      const wrongWorkspaceTarget = await principal([otherWorkspaceId])
      await expect(repo.bindAccount({ ...bindInput, deliveryId: duplicate.id, expectedRevision: duplicate.revision, targetAccountId: wrongWorkspaceTarget.accountId }))
        .rejects.toMatchObject({ code: 'ACCOUNT_NOT_BINDABLE' })

      // Direct SQL still enforces the pair and exact account identity; FK targets
      // additionally prevent later deletion of either durable relationship.
      for (const [accountId, identityId] of [[alternate.accountId, null], [null, alternate.identityId], [alternate.accountId, target.identityId]]) {
        await expect(scoped(ops, workspaceId, client => client.query(
          'UPDATE workspace_customer_deliveries SET target_account_id=$2,target_identity_id=$3 WHERE id=$1',
          [duplicate.id, accountId, identityId],
        ))).rejects.toMatchObject({ code: '23514' })
      }
      await expect(database.query('DELETE FROM platform_password_accounts WHERE id=$1', [target.accountId]))
        .rejects.toMatchObject({ code: '23503', constraint: 'customer_deliveries_account_identity_fk' })
      await expect(database.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND identity_id=$2', [workspaceId, target.identityId]))
        .rejects.toMatchObject({ code: '23503', constraint: 'customer_deliveries_workspace_identity_fk' })

      const renamedLogin = `renamed-${target.accountId}@example.test`
      await database.query('UPDATE platform_password_accounts SET login_identifier=$2 WHERE id=$1', [target.accountId, renamedLogin])
      expect(await repo.get(workspaceId, historicalId)).toMatchObject({ targetAccountLogin: renamedLogin, targetIdentityId: target.identityId, revision: 8 })
      await database.query("UPDATE platform_password_accounts SET status='suspended' WHERE id=$1", [target.accountId])
      try {
        expect(await repo.getByIdentity(workspaceId, target.identityId)).toMatchObject({ id: historicalId,
          targetAccountLogin: renamedLogin, targetAccountId: target.accountId, effectiveAt: null, paymentStatus: 'unpaid', revision: 8 })
        expect((await repo.list(workspaceId)).find(delivery => delivery.id === historicalId))
          .toMatchObject({ targetAccountLogin: renamedLogin, targetIdentityId: target.identityId, effectiveAt: null, revision: 8 })
        expect((await database.query('SELECT status FROM platform_password_accounts WHERE id=$1', [target.accountId])).rows)
          .toEqual([{ status: 'suspended' }])
        expect((await database.query('SELECT revision::integer AS revision,effective_at,payment_status FROM workspace_customer_deliveries WHERE id=$1', [historicalId])).rows)
          .toEqual([{ revision: 8, effective_at: null, payment_status: 'unpaid' }])
        expect(await bindingAudits(historicalId)).toEqual(audits)
      } finally {
        await database.query("UPDATE platform_password_accounts SET status='active' WHERE id=$1", [target.accountId])
      }

      const ineligible = await principal()
      const rejected = await create('Inactive target')
      const rejectedInput = { ...bindInput, deliveryId: rejected.id, expectedRevision: rejected.revision, targetAccountId: ineligible.accountId }
      for (const change of [
        { apply: "UPDATE platform_password_accounts SET status='suspended' WHERE id=$1", restore: "UPDATE platform_password_accounts SET status='active' WHERE id=$1", values: [ineligible.accountId] },
        { apply: "UPDATE platform_password_accounts SET account_type='platform' WHERE id=$1", restore: "UPDATE platform_password_accounts SET account_type='merchant' WHERE id=$1", values: [ineligible.accountId] },
        { apply: "UPDATE platform_password_accounts SET workspace_ids=ARRAY[]::text[] WHERE id=$1", restore: 'UPDATE platform_password_accounts SET workspace_ids=ARRAY[$2]::text[] WHERE id=$1', values: [ineligible.accountId], restoreValues: [ineligible.accountId, workspaceId] },
        { apply: "UPDATE platform_identities SET risk_decision='block' WHERE id=$1", restore: "UPDATE platform_identities SET risk_decision='allow' WHERE id=$1", values: [ineligible.identityId] },
        { apply: "UPDATE platform_identities SET access_status='suspended',suspended_at=now(),suspended_by='release-212',suspension_reason='test' WHERE id=$1", restore: "UPDATE platform_identities SET access_status='active',suspended_at=NULL,suspended_by=NULL,suspension_reason=NULL WHERE id=$1", values: [ineligible.identityId] },
        { apply: "UPDATE workspace_members SET status='suspended' WHERE identity_id=$1", restore: "UPDATE workspace_members SET status='active' WHERE identity_id=$1", values: [ineligible.identityId] },
        { apply: "UPDATE workspaces SET status='disabled' WHERE id=$1", restore: "UPDATE workspaces SET status='active' WHERE id=$1", values: [workspaceId] },
      ]) {
        await database.query(change.apply, change.values)
        try {
          await expect(repo.bindAccount(rejectedInput)).rejects.toMatchObject({ code: 'ACCOUNT_NOT_BINDABLE' })
          expect(await bindingAudits(rejected.id)).toEqual([])
        } finally {
          await database.query(change.restore, change.restoreValues ?? change.values)
        }
      }
      expect(await repo.get(workspaceId, rejected.id)).toMatchObject({ targetAccountId: null, targetIdentityId: null, revision: rejected.revision })

      const rollbackDelivery = await create('Audit rollback')
      const rollbackInput = { ...bindInput, deliveryId: rollbackDelivery.id, expectedRevision: rollbackDelivery.revision, targetAccountId: alternate.accountId }
      const persistedBefore = (await database.query('SELECT to_jsonb(d) AS row FROM workspace_customer_deliveries d WHERE id=$1', [rollbackDelivery.id])).rows[0].row
      await database.query(`
        CREATE FUNCTION public.release_212_reject_binding_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.action='customer_delivery.account.bind' THEN
            RAISE EXCEPTION 'release 212 injected audit failure' USING ERRCODE='P0001';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER release_212_reject_binding_audit BEFORE INSERT ON workspace_operation_audit
          FOR EACH ROW EXECUTE FUNCTION public.release_212_reject_binding_audit();
      `)
      try {
        await expect(repo.bindAccount(rollbackInput)).rejects.toMatchObject({ code: 'P0001', message: 'release 212 injected audit failure' })
        expect((await database.query('SELECT to_jsonb(d) AS row FROM workspace_customer_deliveries d WHERE id=$1', [rollbackDelivery.id])).rows[0].row).toEqual(persistedBefore)
        expect(await bindingAudits(rollbackDelivery.id)).toEqual([])
      } finally {
        await database.query('DROP TRIGGER release_212_reject_binding_audit ON workspace_operation_audit; DROP FUNCTION public.release_212_reject_binding_audit()')
      }
      expect(await repo.bindAccount(rollbackInput)).toMatchObject({ targetAccountId: alternate.accountId, revision: rollbackDelivery.revision + 1 })
      expect(await bindingAudits(rollbackDelivery.id)).toHaveLength(1)

      for (const relation of ['account', 'member'] as const) {
        const racing = await principal()
        const racingDelivery = await create(`Concurrent ${relation} revocation`)
        const mutation = relation === 'account'
          ? { sql: 'UPDATE platform_password_accounts SET status=$2 WHERE id=$1', id: racing.accountId }
          : { sql: 'UPDATE workspace_members SET status=$2 WHERE identity_id=$1', id: racing.identityId }
        const holder = await opsPool.connect()
        const revoker = await database.connect()
        try {
          await holder.query('BEGIN')
          await holder.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.platform_scope','platform_ops',true)", [workspaceId])
          expect((await lockTarget(holder, racing.accountId)).rows).toEqual([{ account_id: racing.accountId, identity_id: racing.identityId, login: racing.login }])
          await revoker.query("SET lock_timeout='150ms'")
          await expect(revoker.query(mutation.sql, [mutation.id, 'suspended'])).rejects.toMatchObject({ code: '55P03' })
          await holder.query('COMMIT')
          await revoker.query('RESET lock_timeout')
          expect((await revoker.query(mutation.sql, [mutation.id, 'suspended'])).rowCount).toBe(1)
          await expect(repo.bindAccount({ ...bindInput, deliveryId: racingDelivery.id, expectedRevision: racingDelivery.revision, targetAccountId: racing.accountId }))
            .rejects.toMatchObject({ code: 'ACCOUNT_NOT_BINDABLE' })

          // Reverse the order: an uncommitted lifecycle update prevents acquiring
          // eligibility locks; after it commits, the helper must return no target.
          await revoker.query(mutation.sql, [mutation.id, 'active'])
          await revoker.query('BEGIN')
          await revoker.query(mutation.sql, [mutation.id, 'suspended'])
          await holder.query('BEGIN')
          await holder.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.platform_scope','platform_ops',true)", [workspaceId])
          await holder.query("SET LOCAL lock_timeout='150ms'")
          await expect(lockTarget(holder, racing.accountId)).rejects.toMatchObject({ code: '55P03' })
          await holder.query('ROLLBACK')
          await revoker.query('COMMIT')
          expect((await scoped(opsPool, workspaceId, client => lockTarget(client, racing.accountId))).rows).toEqual([])
          expect(await bindingAudits(racingDelivery.id)).toEqual([])
          expect(await repo.get(workspaceId, racingDelivery.id)).toMatchObject({ targetAccountId: null, revision: racingDelivery.revision })
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined)
          await revoker.query('ROLLBACK').catch(() => undefined)
          await revoker.query('RESET lock_timeout').catch(() => undefined)
          holder.release()
          revoker.release()
        }
      }
      const scopes = (await ops.query("SELECT current_setting('app.workspace_id',true) AS workspace,current_setting('app.platform_scope',true) AS platform")).rows[0]
      expect([null, '']).toContain(scopes.workspace)
      expect([null, '']).toContain(scopes.platform)
    } finally {
      await app?.end()
      await ops?.end()
      await database?.end()
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 300_000)
})
