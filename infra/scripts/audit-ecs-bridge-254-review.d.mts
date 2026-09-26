export function auditBridgeReview(directory: string): {
  schema_version: 'ecs-bridge-254-compatibility-audit/1'
  status: 'blocked'
  deployable: false
  runtime_verified: false
  bridge_base_commit: string
  migration_commit: string
  review_tree_sha256: string
  blockers: Array<{ code: string; evidence: string; detail: string }>
  requires_pg17_evidence: string[]
}
