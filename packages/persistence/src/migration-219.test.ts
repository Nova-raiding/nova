import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 219 public platform rules', () => {
  it('creates a non-workspace-scoped public rule catalog with merchant read-only ACL', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 219)
    expect(migration).toMatchObject({ version: 219, name: 'public_platform_rules' })
    const sql = migration?.sql ?? ''
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public_platform_rule_versions')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public_platform_rule_audits')
    expect(sql).toContain('GRANT SELECT ON public_platform_rule_versions TO merchant_app')
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON public_platform_rule_versions TO merchant_ops')
    expect(sql).toContain("platform IN ('jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin')")
    expect(sql).not.toContain('workspace_id')
  })
})
