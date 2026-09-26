import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BRIDGE_BASE_COMMIT, buildBridgeReview, verifyMigrationInputs } from '../infra/scripts/prepare-ecs-bridge-254-review.mjs'

const MIGRATION_COMMIT = 'd0552b975e69f4ba713ec1c003078f521b69f51a'
const temporary: string[] = []
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('B-derived 254 source review package', () => {
  it('accepts only the pinned unchanged 1–244 history and ten contiguous additions', () => {
    const added = verifyMigrationInputs(MIGRATION_COMMIT)
    expect(added).toHaveLength(10)
    expect(added[0]).toBe('packages/persistence/src/migrations/245_local_plugin_authorized_timestamp.sql')
    expect(added.at(-1)).toBe('packages/persistence/src/migrations/254_merchant_entitlement_snapshot_cursor.sql')
    expect(() => verifyMigrationInputs(BRIDGE_BASE_COMMIT)).toThrow('migration inventory')
    expect(() => verifyMigrationInputs('not-a-commit')).toThrow('full Git SHA')
  })

  it('creates a review-only tree with the exact allowlisted source difference', () => {
    const parent = mkdtempSync(join(tmpdir(), 'bridge-254-source-review-'))
    temporary.push(parent)
    const output = join(parent, 'review')
    const manifest = buildBridgeReview({ migrationCommit: MIGRATION_COMMIT, output })
    expect(manifest).toMatchObject({ schema_version: 'ecs-bridge-254-source-review/1', status: 'review_only', deployable: false, bridge_base_commit: BRIDGE_BASE_COMMIT, migration_commit: MIGRATION_COMMIT, migration_target_version: 254 })
    expect(manifest.changed_paths).toHaveLength(12)
    expect(manifest.changed_paths).toContain('packages/persistence/src/migration.ts')
    expect(manifest.changed_paths).toContain('release-metadata.json')
    expect(Object.keys(manifest.migration_digests)).toHaveLength(10)
    expect(JSON.parse(readFileSync(join(output, 'review-source/release-metadata.json'), 'utf8')).expectedMigrationVersion).toBe(254)
    const newSql = readFileSync(join(output, 'review-source/packages/persistence/src/migrations/254_merchant_entitlement_snapshot_cursor.sql'))
    expect(newSql.equals(execFileSync('git', ['show', `${MIGRATION_COMMIT}:packages/persistence/src/migrations/254_merchant_entitlement_snapshot_cursor.sql`]))).toBe(true)
    expect(readFileSync(join(output, 'review-manifest.json'), 'utf8')).toContain('"deployable": false')
    expect(() => buildBridgeReview({ migrationCommit: MIGRATION_COMMIT, output })).toThrow('new absolute canonical path')
  })
})
