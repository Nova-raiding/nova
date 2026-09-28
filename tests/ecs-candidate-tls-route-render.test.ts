import { describe, expect, it } from 'vitest'
import { renderCandidateTlsRoute } from '../infra/scripts/render-ecs-candidate-tls-route.mjs'

const project = 'merchant-demo-candidate-v2'
const network = `${project}_private`
const releaseId = 'release-candidate-review'
const gitSha = 'a'.repeat(40)
const sourceSha256 = `sha256:${'b'.repeat(64)}`
const manifestSha256 = 'c'.repeat(64)
const imageSetDigest = `sha256:${'d'.repeat(64)}`
const apiRef = `registry.example/api@sha256:${'e'.repeat(64)}`
const gatewayRef = `registry.example/gateway@sha256:${'f'.repeat(64)}`
const apiId = '1'.repeat(64)
const networkId = '2'.repeat(64)
const apiImageId = `sha256:${'3'.repeat(64)}`
const gatewayImageId = `sha256:${'4'.repeat(64)}`

function fixture() {
  const source = {
    name: project, 'x-eight-image-set-digest': imageSetDigest,
    services: {
      postgres: { image: 'postgres-image', environment: { POSTGRES_PASSWORD: 'never-copy' } },
      redis: { image: 'redis-image' },
      migrate: { image: 'migrate-image', environment: { DATABASE_URL: 'never-copy' } },
      api: { image: apiRef, labels: {
        'com.storenova.release.id': releaseId,
        'org.opencontainers.image.revision': gitSha,
        'com.storenova.release.source_sha256': sourceSha256,
      }, environment: {
        RELEASE_ID: releaseId, RELEASE_GIT_SHA: gitSha,
        RELEASE_MANIFEST_SHA256: manifestSha256, RELEASE_IMAGE_SET_DIGEST: imageSetDigest,
        DATABASE_URL: 'never-copy', MODEL_RELAY_API_KEY: 'never-copy',
      } },
    },
    networks: { default: { name: network, external: false } },
  }
  const images = { schema_version: 1, release_id: releaseId, release_git_sha: gitSha,
    source_sha256: sourceSha256,
    image_digests: { 'merchant-api': `sha256:${'e'.repeat(64)}`, 'pilot-gateway': `sha256:${'f'.repeat(64)}` },
    image_references: { 'merchant-api': apiRef, 'pilot-gateway': gatewayRef },
  }
  const container = { Id: apiId, Image: apiImageId, Name: `/${project}-api-1`, State: { Running: true },
    Config: { Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': 'api',
      'com.docker.compose.oneoff': 'False', 'com.docker.compose.container-number': '1',
      'com.storenova.release.id': releaseId, 'org.opencontainers.image.revision': gitSha,
      'com.storenova.release.source_sha256': sourceSha256 } },
    HostConfig: { PortBindings: {} },
    NetworkSettings: { Networks: { [network]: { IPAddress: '172.20.0.8', NetworkID: networkId } } },
  }
  return { source, images, container }
}

describe('protected independent candidate TLS route renderer', () => {
  it('pins exact release, API, gateway and private network without credentials or public ports', () => {
    const { source, images, container } = fixture()
    const route = renderCandidateTlsRoute(source, images, container, apiImageId, gatewayImageId)
    expect(route.x_candidate_tls_route).toEqual({
      schema_version: 'ecs-candidate-tls-route/1', api_container_id: apiId,
      api_image_id: apiImageId, api_network_id: networkId,
      gateway_image_id: gatewayImageId, gateway_image_ref: gatewayRef,
      host: '127.0.0.1', port: 18443,
    })
    expect(route.networks.default).toEqual({ name: network, external: false })
    expect(Object.keys(route.services).sort()).toEqual(['api', 'pilot-gateway'])
    expect(JSON.stringify(route)).not.toMatch(/never-copy|DATABASE_URL|MODEL_RELAY_API_KEY|POSTGRES_PASSWORD|ports|18444|:443/u)
  })

  it('refuses source drift, extra service, host publication and mismatched release or image digest', () => {
    for (const mutate of [
      (x: ReturnType<typeof fixture>) => { x.source.name = 'merchant-production' },
      (x: ReturnType<typeof fixture>) => { x.source.networks.default.name = 'merchant_production_default' },
      (x: ReturnType<typeof fixture>) => { x.source.networks.default.external = true },
      (x: ReturnType<typeof fixture>) => { x.source.services.api.environment.RELEASE_ID = 'release-other' },
      (x: ReturnType<typeof fixture>) => { x.source['x-eight-image-set-digest'] = `sha256:${'0'.repeat(64)}` },
      (x: ReturnType<typeof fixture>) => { (x.source.services.api as typeof x.source.services.api & { ports: string[] }).ports = ['127.0.0.1:18787:8787'] },
      (x: ReturnType<typeof fixture>) => { Object.assign(x.source.services, { worker: {} }) },
      (x: ReturnType<typeof fixture>) => { x.images.release_git_sha = '0'.repeat(40) },
      (x: ReturnType<typeof fixture>) => { x.images.image_digests['pilot-gateway'] = `sha256:${'0'.repeat(64)}` },
      (x: ReturnType<typeof fixture>) => { x.images.image_references['pilot-gateway'] = 'gateway:latest' },
    ]) {
      const value = fixture(); mutate(value)
      expect(() => renderCandidateTlsRoute(value.source, value.images, value.container, apiImageId, gatewayImageId)).toThrow()
    }
  })

  it('refuses a different runtime container, image, network or published API port', () => {
    for (const mutate of [
      (x: ReturnType<typeof fixture>) => { x.container.Name = '/merchant-demo-other-api-1' },
      (x: ReturnType<typeof fixture>) => { x.container.Image = gatewayImageId },
      (x: ReturnType<typeof fixture>) => { x.container.NetworkSettings.Networks[network].NetworkID = '0'.repeat(64) },
      (x: ReturnType<typeof fixture>) => { x.container.HostConfig.PortBindings = { '8787/tcp': [{ HostIp: '127.0.0.1', HostPort: '18787' }] } },
    ]) {
      const value = fixture(); mutate(value)
      if (value.container.NetworkSettings.Networks[network].NetworkID === '0'.repeat(64)) {
        // The current network ID is captured; a missing ID, rather than a different valid ID, is unsafe.
        value.container.NetworkSettings.Networks[network].NetworkID = ''
      }
      expect(() => renderCandidateTlsRoute(value.source, value.images, value.container, apiImageId, gatewayImageId)).toThrow()
    }
  })

  it('accepts only a private merchant UI from the same release image set', () => {
    const value: any = fixture()
    const uiRef = `registry.example/ui@sha256:${'5'.repeat(64)}`
    value.source.services.api.networks = { default: { aliases: ['merchant-api'] } }
    Object.assign(value.source.services, { ui: { image: uiRef, labels: {
      'org.opencontainers.image.revision': gitSha,
      'com.storenova.release.source_sha256': sourceSha256,
    } } })
    value.images.image_references['merchant-ui'] = uiRef
    value.images.image_digests['merchant-ui'] = uiRef.split('@')[1]
    expect(renderCandidateTlsRoute(value.source, value.images, value.container, apiImageId, gatewayImageId).services['pilot-gateway']).toBeDefined()
    value.source.services.ui.ports = ['127.0.0.1:18444:8080']
    expect(() => renderCandidateTlsRoute(value.source, value.images, value.container, apiImageId, gatewayImageId)).toThrow()
  })
})
