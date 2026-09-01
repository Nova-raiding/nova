import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('local PostgreSQL demo seed contract', () => {
  it('is tenant-scoped, replay-safe, and explicitly non-production', async () => {
    const sql = await readFile(new URL('../../../infra/local/seed-demo.sql', import.meta.url), 'utf8')
    expect(sql).toContain("set_config('app.workspace_id', 'ws_demo', true)")
    expect(sql).toContain('local_compose_seed')
    expect(sql).toContain('fixture://local-demo/')
    expect(sql).toContain('"productionEvidence":false')
    expect(sql).toContain("'demo_fixture'")
    expect(sql).toContain("'draft','internal','fixture://local-demo/rules/")
    expect(sql).toContain("'demo.fixture.ops_readiness','local_demo'")
    expect(sql).toContain("'false',false,true")
    expect(sql).not.toMatch(/production_canary|official_api|provider_trade_id|access[_-]?token|refresh[_-]?token/iu)
    const membershipInserts = sql.match(/INSERT INTO workspace_members[\s\S]*?;/gu) ?? []
    expect(membershipInserts.length).toBeGreaterThan(0)
    for (const statement of membershipInserts) expect(statement).not.toContain("'platform_ops'")

    for (const relation of [
      'workspace_commercial_settings', 'workspace_subscriptions', 'workspace_platform_settings',
      'creative_point_access_state', 'creative_point_operations', 'creative_point_grants', 'creative_point_ledger_events',
      'platform_accounts', 'products', 'tasks', 'business_entity_snapshots', 'rule_pack_versions',
      'workspace_operation_alerts', 'workspace_operation_audit', 'workspace_support_tickets',
      'workspace_support_ticket_events', 'ops_incidents', 'ops_incident_timeline',
      'billing_orders', 'model_usage_ledger', 'platform_feature_flags', 'platform_feature_flag_targets',
    ]) expect(sql).toContain(`INSERT INTO ${relation}`)

    expect(sql).toContain("'pending','fixture'")
    expect(sql).toContain("'pending_cost'")
    expect(sql).toContain("'cpo_demo_fixture_grant'")
    expect(sql).toContain("'cpg_demo_fixture_grant'")
    expect(sql).toContain("'cpl_demo_fixture_grant'")
    expect(sql).toContain('WHERE creative_point_access_state.available_points IS NULL')
    expect((sql.match(/ON CONFLICT/gu) ?? []).length).toBeGreaterThanOrEqual(18)
  })
})
