export function buildBridgeOverlay(input: { review: string; output: string }): {
  schema_version: 'ecs-bridge-254-compatibility-overlay/1'
  status: 'review_only'
  deployable: false
  runtime_verified: false
  source_review_tree_sha256: string
  bridge_base_commit: string
  migration_commit: string
  changed_paths: string[]
  changed_digests: Record<string, string>
  overlay_tree_sha256: string
  missing_proof: string[]
}
