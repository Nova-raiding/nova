export interface Bridge255ForwardResult {
  status: 'recovery_255_verified_fenced'
  release_authorized: false
  production_cutover_authorized: false
  phase: 'verified_255'
  database_version: 255
  ingress_fenced: true
}

export function executeBridge255ForwardMigration(input: {
  plan: Record<string, any>
  deploymentNonce: string
  publicKeyPem: string
  control: Record<string, any>
  runtime: Record<string, any>
  now?: Date
}): Promise<Bridge255ForwardResult>

export function resumeBridge255ForwardRecovery(input: {
  plan: Record<string, any>
  publicKeyPem: string
  control: Record<string, any>
  runtime: Record<string, any>
  now?: Date
}): Promise<Bridge255ForwardResult>
