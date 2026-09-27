import type { CandidateApiDescriptor } from './launch-ecs-candidate-tls-gateway.mjs'

export interface CandidateTlsRouteSource {
  name: string
  services: Record<string, { image?: string; labels?: Record<string, string>; environment?: Record<string, string>; ports?: unknown[] }>
  networks: { default?: { name?: string; external?: boolean } }
  'x-eight-image-set-digest'?: string
}

export interface CandidateTlsRouteImages {
  schema_version: number
  release_id: string
  release_git_sha: string
  source_sha256: string
  image_digests: Record<string, string>
  image_references: Record<string, string>
}

export interface CandidateTlsRouteManifest {
  name: string
  services: Record<string, unknown>
  networks: { default: { name: string; external: false } }
  x_candidate_tls_route: {
    schema_version: 'ecs-candidate-tls-route/1'
    api_container_id: string
    api_image_id: string
    api_network_id: string
    gateway_image_id: string
    gateway_image_ref: string
    host: '127.0.0.1'
    port: 18443
  }
}

export function renderCandidateTlsRoute(
  source: CandidateTlsRouteSource,
  images: CandidateTlsRouteImages,
  apiContainer: CandidateApiDescriptor,
  apiImageId: string,
  gatewayImageId: string,
): CandidateTlsRouteManifest

export function main(argv?: string[]): void
