export const BRIDGE_BASE_COMMIT: string
export function verifyMigrationInputs(migrationCommit: string): string[]
export function buildBridgeReview(input: { migrationCommit: string; output: string }): {
  schema_version: 'ecs-bridge-254-source-review/1'
  status: 'review_only'
  deployable: false
  bridge_base_commit: string
  migration_commit: string
  bridge_base_archive_sha256: string
  migration_target_version: 254
  migration_digests: Record<string, string>
  changed_paths: string[]
  review_tree_sha256: string
}
