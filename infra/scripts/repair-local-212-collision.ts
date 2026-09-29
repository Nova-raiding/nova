import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const legacy = ['customer_delivery_account_binding', 'eada99cb91760dcea0d26a771e281e9f7d3654e93ad3a4088c8af1ffa409aa66'] as const
const canonical = [[212, 'customer_delivery_training_without_evidence'], [213, 'customer_delivery_manual_verification'], [214, 'customer_delivery_archival'], [215, 'customer_delivery_account_binding']] as const
const digest = (s: string) => createHash('sha256').update(s).digest('hex')
const abort = (code: string): never => { throw new Error(code) }

export async function repairLocal212Collision(url: string) {
  if (process.env.LOCAL_MIGRATION_212_COLLISION_APPROVED !== 'true') abort('LOCAL_212_BRIDGE_APPROVAL_REQUIRED')
  const target = new URL(url)
  const host = target.hostname.toLowerCase()
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) abort('LOCAL_212_BRIDGE_LOCAL_DATABASE_REQUIRED')
  if (!/^(?:test|release_211)_/u.test(decodeURIComponent(target.pathname.slice(1)))) abort('LOCAL_212_BRIDGE_TEST_DATABASE_REQUIRED')
  const db = new Client({ connectionString: url }); await db.connect()
  try {
    await db.query('BEGIN')
    if (!(await db.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock(731942851) ok')).rows[0]?.ok) abort('LOCAL_212_BRIDGE_LOCK_BUSY')
    const history = (await db.query<{ count: number; tail: number }>('SELECT count(*)::int count,max(version)::int tail FROM schema_migrations')).rows[0]
    if (history?.count !== 212 || history.tail !== 212) abort('LOCAL_212_BRIDGE_HISTORY_NOT_EXACT_PREFIX')
    const identity = (await db.query<{ name: string; checksum: string }>('SELECT name,checksum FROM schema_migrations WHERE version=212')).rows[0]
    if (identity?.name !== legacy[0] || identity.checksum !== legacy[1]) abort('LOCAL_212_BRIDGE_IDENTITY_MISMATCH')
    if ((await db.query<{ n: number }>('SELECT count(*)::int n FROM workspace_customer_deliveries WHERE target_account_id IS NOT NULL OR target_identity_id IS NOT NULL')).rows[0]!.n) abort('LOCAL_212_BRIDGE_BOUND_DELIVERY_PRESENT')
    const catalog = (await db.query<{ cols: number; cons: number; funcs: number; triggers: number }>(`SELECT
      (SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND table_name='workspace_customer_deliveries' AND column_name IN ('target_account_id','target_identity_id')) cols,
      (SELECT count(*)::int FROM pg_constraint WHERE conrelid='workspace_customer_deliveries'::regclass AND conname IN ('customer_deliveries_account_identity_fk','customer_deliveries_account_pair_check','customer_deliveries_workspace_identity_fk','customer_deliveries_workspace_identity_unique')) cons,
      (SELECT count(*)::int FROM pg_proc WHERE oid IN (to_regprocedure('public.lock_customer_delivery_account_target(text,uuid)'),to_regprocedure('public.guard_customer_delivery_account_binding()'))) funcs,
      (SELECT count(*)::int FROM pg_trigger WHERE tgrelid='workspace_customer_deliveries'::regclass AND tgname='customer_delivery_account_binding_guard' AND NOT tgisinternal) triggers`)).rows[0]
    if (catalog?.cols !== 2 || catalog.cons !== 4 || catalog.funcs !== 2 || catalog.triggers !== 1) abort('LOCAL_212_BRIDGE_CATALOG_MISMATCH')
    const artifacts = new Map<number, string>()
    for (const [v, n] of canonical) artifacts.set(v, await readFile(resolve(root, `packages/persistence/src/migrations/${v}_${n}.sql`), 'utf8'))
    for (const v of [212, 213, 214]) await db.query(artifacts.get(v)!)
    let normalize = artifacts.get(215)!.slice(artifacts.get(215)!.indexOf('-- merchant_ops'))
    normalize = normalize.replaceAll('CREATE FUNCTION public.', 'CREATE OR REPLACE FUNCTION public.').replace('CREATE TRIGGER customer_delivery_account_binding_guard', 'DROP TRIGGER customer_delivery_account_binding_guard ON workspace_customer_deliveries;\nCREATE TRIGGER customer_delivery_account_binding_guard')
    await db.query(normalize)
    const post = (await db.query<{ archived: boolean; idx: boolean; paths: number }>(`SELECT
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='workspace_customer_deliveries' AND column_name='archived_at') archived,
      to_regclass('public.customer_deliveries_workspace_active_company_unique_idx') IS NOT NULL idx,
      (SELECT count(*)::int FROM pg_proc WHERE oid IN ('public.lock_customer_delivery_account_target(text,uuid)'::regprocedure,'public.guard_customer_delivery_account_binding()'::regprocedure) AND proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']) paths`)).rows[0]
    if (!post?.archived || !post.idx || post.paths !== 2) abort('LOCAL_212_BRIDGE_POSTCHECK_FAILED')
    await db.query('UPDATE schema_migrations SET name=$1,checksum=$2 WHERE version=212', [canonical[0][1], digest(artifacts.get(212)!)])
    for (const [v, n] of canonical.slice(1)) await db.query('INSERT INTO schema_migrations(version,name,checksum) VALUES($1,$2,$3)', [v, n, digest(artifacts.get(v)!)])
    await db.query('COMMIT'); return { repaired: true, through: 215 }
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e } finally { await db.end() }
}

const invokedPath = process.argv[1]
if (invokedPath && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  if (process.env.LOCAL_MIGRATION_212_COLLISION_APPROVED !== 'true') abort('LOCAL_212_BRIDGE_APPROVAL_REQUIRED')
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL_REQUIRED')
  repairLocal212Collision(databaseUrl).then(x => console.log(x)).catch(e => { console.error(e.message); process.exitCode = 1 })
}
