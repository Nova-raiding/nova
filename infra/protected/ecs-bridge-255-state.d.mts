export interface Bridge255TransitionReview {
  schema_version: 'ecs-bridge-255-transition-review/1'
  status: 'review_only'
  from: string
  to: string
  plan_sha256: string
  previous_signed_journal_sha256: string
  next_signed_journal_sha256: string
  host_contract: Readonly<Record<string, string>>
  required_observations: readonly string[]
  production_authorized: false
  deployable: false
  blockers: string[]
}

export const BRIDGE_255_HOST_CONTRACT: Readonly<Record<string, string>>
export const BRIDGE_255_REQUIRED_OBSERVATIONS: Readonly<Record<string, readonly string[]>>
export function reviewBridge255Transition(input: {
  plan: unknown
  capture: unknown
  previous: unknown
  next: unknown
  publicKeyPem: string
  previousObservation: unknown
  nextObservation: unknown
  now?: Date
}): Bridge255TransitionReview
