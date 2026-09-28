export interface Bridge255PhaseReview {
  schema_version: 'ecs-bridge-255-phase-review/1'
  status: 'review_only'
  phase: string
  plan_sha256: string
  journal_sha256: string
  production_authorized: false
  deployable: false
  blockers: string[]
}

export function validateBridge255Plan(plan: unknown): string
export function reviewBridge255Phase(input: {
  plan: unknown
  journal: unknown
  publicKeyPem: string
  capture: unknown
  observation: unknown
  now?: Date
}): Bridge255PhaseReview
