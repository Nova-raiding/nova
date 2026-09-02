export interface RelayEvidenceOptions {
  environment?: string
  fixtureFallback?: boolean
}

export function assertRelayEvidence(method: string, result: unknown, options: RelayEvidenceOptions): void
