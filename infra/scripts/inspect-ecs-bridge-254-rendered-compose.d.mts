export interface Bridge254ComposeInspection {
  schema_version: 'ecs-bridge-254-compose-inspection/1'
  status: 'review_only'
  deployable: false
  runtime_verified: false
  release_id: string
  release_git_sha: string
  inspected_services: string[]
}

export function inspectBridge254Compose(config: unknown): Bridge254ComposeInspection
