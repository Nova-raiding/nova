export interface CandidateFullGatewayDescriptor {
  Id: string
  Image: string
  Name: string
  State?: { Running?: boolean }
  Config?: { Image?: string; Labels?: Record<string, string> }
  HostConfig?: {
    NetworkMode?: string
    PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string } | null> | null>
  }
  NetworkSettings?: { Networks?: Record<string, { NetworkID?: string; Aliases?: string[] }> }
  Mounts?: Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }>
}

export function assertCandidateUpstream(
  container: CandidateFullGatewayDescriptor,
  expected: { id: string; imageId: string; project: string; service: string; network: string; networkId: string },
): void

export function assertCandidateFullGateway(
  container: CandidateFullGatewayDescriptor,
  expected: {
    id: string
    imageId: string
    imageRef: string
    name: string
    project: string
    releaseId: string
    network: string
    networkId: string
    port: number
    certDir: string
  },
): void
