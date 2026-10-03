import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('ECS migration release target binding', () => {
  it('binds preflight and restore evidence to the candidate release metadata target', () => {
    const preflight = readFileSync('infra/scripts/deploy-preflight-ecs.sh', 'utf8')
    const metadataCheck = preflight.indexOf('release_metadata_migration_version=$(RELEASE_METADATA_PATH=')
    const targetComparison = preflight.indexOf('[ "$release_metadata_migration_version" = "$EXPECTED_MIGRATION_VERSION" ]')
    const workspaceTailCheck = preflight.indexOf('workspace_latest_migration=$(find packages/persistence/src/migrations')
    expect(metadataCheck).toBeGreaterThan(-1)
    expect(targetComparison).toBeGreaterThan(metadataCheck)
    expect(workspaceTailCheck).toBeGreaterThan(targetComparison)
    expect(preflight).toContain('--kind restore --file "$RESTORE_EVIDENCE_PATH"')
    expect(preflight).toContain('--release-metadata "$root/release-metadata.json"')
    expect(preflight).toContain('--expected-migration-version "$EXPECTED_MIGRATION_VERSION"')
  })

  it('keeps the legacy Kubernetes preflight on the same source/target metadata contract', () => {
    const preflight = readFileSync('infra/scripts/deploy-preflight.sh', 'utf8')
    expect(preflight).toContain('release_metadata_migration_version=$(RELEASE_METADATA_PATH="$repo_root/release-metadata.json" node -e')
    expect(preflight).toContain('[ "$release_metadata_migration_version" = "$EXPECTED_MIGRATION_VERSION" ]')
    expect(preflight).toContain('--release-metadata "$repo_root/release-metadata.json"')
    expect(preflight).toContain('--expected-migration-version "$EXPECTED_MIGRATION_VERSION"')
  })
})
