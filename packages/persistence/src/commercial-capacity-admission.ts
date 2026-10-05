import type { SqlClient } from './repository.js'
import { CommercialStorageEntitlementError, resolveCommercialStorageLimit } from './storage-quota-repository.js'

export class CommercialAbsoluteCapacityError extends Error {
  readonly code = 'COMMERCIAL_QUOTA_EXCEEDED'
  readonly status = 402
  constructor(readonly quota: string, readonly used: number, readonly included: number) { super('COMMERCIAL_QUOTA_EXCEEDED') }
}
/** Caller retains this transaction and lock through the business INSERT and COMMIT. */
export async function requireCommercialAbsoluteCapacityInTransaction(client: SqlClient, input: {
  workspaceId: string
  code: 'max_brands' | 'max_stores'
  operation: 'brand_create' | 'store_bind' | 'account_connect'
  platform?: string
  accountId?: string
}) {
  await client.query(`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1),pg_catalog.hashtext($2))`, ['workspace_subscription_periods_v2', input.workspaceId])
  const projection = await client.query<Parameters<typeof resolveCommercialStorageLimit>[0][number]>('SELECT * FROM public.merchant_entitlement_snapshots_v3(200,NULL,NULL)')
  const included = resolveCommercialStorageLimit(projection.rows, new Date().toISOString(), input.code)
  let used: number
  if (input.operation === 'brand_create') {
    const result = await client.query<{ used: number }>('SELECT count(*)::integer AS used FROM brands WHERE workspace_id=$1', [input.workspaceId])
    used = Number(result.rows[0]?.used ?? 0) + 1
  } else {
    const result = await client.query<{ accounts: number; bindings: number; account_present: boolean; binding_present: boolean }>(`
      SELECT (SELECT count(*)::integer FROM platform_accounts WHERE workspace_id=$1 AND token_state<>'revoked') AS accounts,
        (SELECT count(DISTINCT (platform,platform_account_id))::integer FROM brand_store_bindings WHERE workspace_id=$1 AND status='active') AS bindings,
        EXISTS(SELECT 1 FROM platform_accounts WHERE workspace_id=$1 AND platform=$2 AND id=$3 AND token_state<>'revoked') AS account_present,
        EXISTS(SELECT 1 FROM brand_store_bindings WHERE workspace_id=$1 AND platform=$2 AND platform_account_id=$3 AND status='active') AS binding_present`, [input.workspaceId, input.platform, input.accountId])
    const fact = result.rows[0]
    if (!fact) throw new CommercialStorageEntitlementError('COMMERCIAL_ENTITLEMENT_UNAVAILABLE')
    used = Math.max(Number(fact.accounts) + (input.operation === 'account_connect' && !fact.account_present ? 1 : 0),
      Number(fact.bindings) + (input.operation === 'store_bind' && !fact.binding_present ? 1 : 0))
  }
  if (!Number.isSafeInteger(used) || used < 0) throw new CommercialStorageEntitlementError('COMMERCIAL_ENTITLEMENT_UNAVAILABLE')
  if (used > included) throw new CommercialAbsoluteCapacityError(input.code, used, included)
}
