export interface CandidateRoute {
  origin: string
  loopback_host: string
  loopback_port: number
  expected_release_id: string
  expected_git_sha: string
  expected_manifest_sha256: string
  expected_image_set_digest: string
  hostname: string
}

export function validateCandidateRoute(value: unknown, mcpBaseUrl: string): CandidateRoute
export function assertCandidateRelease(value: unknown, route: CandidateRoute | Omit<CandidateRoute, 'hostname'>): void
export function readCandidateRoute(path: string, mcpBaseUrl: string): CandidateRoute
export function installCandidateFetchRoute(route: CandidateRoute, transport?: (route: CandidateRoute, url: string, init?: RequestInit, maxBytes?: number) => Promise<Response>): () => void
