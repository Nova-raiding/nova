export const BRIDGE_254_RUNTIME_SERVICES: readonly string[]
export function reviewBridge254CapsuleShape(document: unknown, expected: unknown, now?: Date): {
  status: 'review_only'
  structure_consistent: boolean
  deployable: false
  signature_verified: false
  runtime_verified: false
  source_provenance_verified: false
  errors: string[]
}
