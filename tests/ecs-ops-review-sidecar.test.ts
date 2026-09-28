import { describe, expect, it } from 'vitest';
import { candidateOpsReviewTlsConfig, createOpsSidecarCompose, validateOpsSidecarInputs } from '../infra/scripts/render-ecs-ops-review-sidecar.mjs';

const gitSha = 'd3a3d3faa274fcb41dbd5dad3361eb0a80f1dde4';
const sourceSha = `sha256:${'a'.repeat(64)}`;
const releaseId = 'release-d3a3d3fa-ops-ui-20260928';
const apiRef = `127.0.0.1:5000/storenova/merchant-api@sha256:${'1'.repeat(64)}`;
const opsRef = `127.0.0.1:5000/storenova/merchant-ops-ui@sha256:${'2'.repeat(64)}`;
const gatewayRef = `127.0.0.1:5000/storenova/pilot-gateway@sha256:${'3'.repeat(64)}`;
const pgRef = `127.0.0.1:5000/postgres:17-alpine@sha256:${'4'.repeat(64)}`;
const redisRef = `redis:7-alpine@sha256:${'5'.repeat(64)}`;
const project = 'merchant-demo-d3a3ops';
const networkName = `${project}_private`;
const id = (digit: string) => digit.repeat(64);

function fixture() {
  const identity = { release_id: releaseId, git_sha: gitSha, source_sha256: sourceSha };
  const artifacts = ['merchant-api', 'merchant-worker', 'merchant-ui', 'merchant-ops-ui', 'payment-gateway', 'pilot-gateway'];
  const refs = Object.fromEntries(artifacts.map((name, index) => [name, index === 0 ? apiRef : index === 3 ? opsRef : index === 5 ? gatewayRef : `127.0.0.1:5000/storenova/${name}@sha256:${String(index + 1).repeat(64)}`]));
  const images = { schema_version: 1, release_id: releaseId, release_git_sha: gitSha, source_sha256: sourceSha, image_references: refs,
    image_digests: Object.fromEntries(Object.entries(refs).map(([name, ref]) => [name, (ref as string).split('@')[1]])) };
  const compose = { name: project, 'x-eight-image-set-digest': `sha256:${'6'.repeat(64)}`,
    networks: { default: { name: networkName, external: false } }, services: {
      api: { image: apiRef, environment: { RELEASE_ID: releaseId, RELEASE_GIT_SHA: gitSha, RELEASE_MANIFEST_SHA256: '7'.repeat(64), RELEASE_IMAGE_SET_DIGEST: `sha256:${'6'.repeat(64)}` } },
      postgres: { image: pgRef }, redis: { image: redisRef }, migrate: { image: pgRef },
    } };
  const manifest = { schema: 'isolated-demo-candidate/1', deployment_scope: 'isolated_four_service_candidate', release_id: releaseId,
    release_git_sha: gitSha, source_sha256: sourceSha, migration_target: 255, public_ports: [],
    image_references: { ...refs, 'postgres-migration': pgRef, 'candidate-redis': redisRef } };
  const containers = Object.fromEntries(['api', 'postgres', 'redis'].map((service, index) => [service, {
    Id: id(String(index + 1)), Image: `sha256:${String(index + 1).repeat(64)}`, State: { Running: true }, Config: { Labels: {
      'com.docker.compose.project': project, 'com.docker.compose.service': service,
      'com.storenova.release.id': releaseId, 'org.opencontainers.image.revision': gitSha,
      'com.storenova.release.source_sha256': sourceSha,
    } }, HostConfig: { PortBindings: {} }, NetworkSettings: { Networks: { [networkName]: { NetworkID: id('9') } } },
  }]));
  const network = { Name: networkName, Labels: { 'com.docker.compose.project': project },
    Containers: Object.fromEntries(Object.entries(containers).map(([service, container]) => [(container as any).Id, { Name: `${project}-${service}-1` }])) };
  const attestation = { schema: 'ecs-demo-isolated-runtime-attestation/1', status: 'review_only', scope: 'isolated', production_go: false,
    project, release_id: releaseId, git_sha: gitSha, manifest_sha256: `sha256:${'7'.repeat(64)}`,
    postgres: { migration_prefix: 255, roles_verified: true, workspace_rls: { verified: true } },
    containers: Object.fromEntries(Object.entries(containers).map(([service, container]) => [service, { container_id: (container as any).Id, image_id: `sha256:${String(['api', 'postgres', 'redis'].indexOf(service) + 1).repeat(64)}` }])) };
  const imageInspects = { 'merchant-ops-ui': { Id: `sha256:${'2'.repeat(64)}`, RepoDigests: [opsRef], Config: { Labels: {
    'com.storenova.release.id': releaseId, 'org.opencontainers.image.revision': gitSha,
    'com.storenova.release.source_sha256': sourceSha, 'com.storenova.ops.auth_mode': 'password',
  } } }, 'pilot-gateway': { Id: `sha256:${'3'.repeat(64)}`, RepoDigests: [gatewayRef], Config: { Labels: {
    'com.storenova.release.id': releaseId, 'org.opencontainers.image.revision': gitSha,
    'com.storenova.release.source_sha256': sourceSha,
  } } } };
  return { compose, manifest, identity, images, attestation, containers, network, imageInspects, sidecarProject: 'merchant-ops-review-d3a3' };
}

describe('isolated Ops review sidecar', () => {
  it('accepts only the attested PG17 migration-255 candidate and generates loopback TLS', () => {
    const input = fixture();
    expect(validateOpsSidecarInputs(input)).toEqual({ baseProject: project, networkName });
    const sidecar = createOpsSidecarCompose({ networkName, sidecarProject: input.sidecarProject, images: input.images,
      identity: input.identity, certDir: '/protected/certs', configPath: '/protected/ops-review-nginx.conf' });
    expect(sidecar.services['ops-ui'].ports).toBeUndefined();
    expect(sidecar.services['review-gateway'].ports).toEqual([{ target: 8443, published: 18445, host_ip: '127.0.0.1', protocol: 'tcp' }]);
    expect(sidecar.networks.candidate).toEqual({ external: true, name: networkName });
    const nginx = candidateOpsReviewTlsConfig();
    expect(nginx).toContain('proxy_set_header X-Forwarded-Host $http_host');
    expect(nginx).toContain('location ^~ /api/');
    expect(nginx).toContain('location ^~ /ops/');
    expect(nginx).not.toContain('listen 443');
  });

  it.each([
    ['PG16 image', (input: any) => { input.compose.services.postgres.image = `postgres:16-alpine@sha256:${'4'.repeat(64)}`; }],
    ['migration 254', (input: any) => { input.attestation.postgres.migration_prefix = 254; }],
    ['old Ops image', (input: any) => { input.imageInspects['merchant-ops-ui'].Config.Labels['org.opencontainers.image.revision'] = '4'.repeat(40); }],
    ['production port', (input: any) => { input.containers.api.HostConfig.PortBindings = { '8787/tcp': [{ HostIp: '0.0.0.0', HostPort: '8787' }] }; }],
    ['other network endpoint', (input: any) => { input.network.Containers[id('8')] = { Name: 'other' }; }],
    ['other project', (input: any) => { input.containers.api.Config.Labels['com.docker.compose.project'] = 'merchant-demo-85575f9c'; }],
  ])('rejects %s', (_name, mutate) => {
    const input = fixture();
    mutate(input);
    expect(() => validateOpsSidecarInputs(input)).toThrow();
  });
});
