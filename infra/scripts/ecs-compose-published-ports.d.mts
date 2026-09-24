export interface RenderedPort {
  target: number | string
  published?: number | string | null
  host_ip?: string
  protocol?: 'tcp' | 'udp' | 'sctp'
}

export interface RenderedCompose {
  services: Record<string, {
    network_mode?: string
    ports?: RenderedPort[]
    [key: string]: unknown
  }>
}

export interface RuntimeContainer {
  Id?: string
  Name?: string
  Config?: { Labels?: Record<string, string | undefined> }
  HostConfig?: {
    NetworkMode?: string
    PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>
  }
  State?: { Running?: boolean }
}

export interface HostListener {
  protocol: 'tcp' | 'udp' | 'sctp'
  hostIp: string
  port: string
}

export interface PublishedPortConflict {
  service: string
  hostIp: string
  protocol: string
  start: number
  end: number
  owner: string
}

export declare function findPublishedPortConflicts(
  compose: RenderedCompose,
  containers: RuntimeContainer[],
  candidateProject: string,
  replacementServices?: string[],
  allowedGatewayId?: string,
  hostListeners?: HostListener[],
): PublishedPortConflict[]

export declare function parseListeners(output: string): HostListener[]
export declare function main(argv?: string[]): void
