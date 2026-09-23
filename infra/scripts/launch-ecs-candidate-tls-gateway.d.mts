export function candidateGatewayConfig(ip: string): string

export function assertCandidateReleaseIdentity(
  value: unknown,
  expected: { releaseId: string; gitSha: string; manifestSha256: string; imageSetDigest: string },
): { release_id: string; release_git_sha: string; manifest_sha256: string; image_set_digest: string }

export interface CandidateApiDescriptor {
  Id: string
  Image: string
  Name: string
  State?: { Running?: boolean }
  Config?: { Labels?: Record<string, string> }
  HostConfig?: { PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> }
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> }
}

export function assertCandidateApi(
  container: CandidateApiDescriptor,
  expected: { id: string; imageId: string; project: string; releaseId: string; network: string },
): string

export interface CandidateGatewayDescriptor {
  Id: string
  Image: string
  Name: string
  State?: { Running?: boolean }
  Config?: { Labels?: Record<string, string> }
  HostConfig?: { PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> }
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> }
}

export function assertCandidateGateway(
  container: CandidateGatewayDescriptor,
  expected: { id: string; imageId: string; name: string; network: string; port: number; apiId: string },
): void
