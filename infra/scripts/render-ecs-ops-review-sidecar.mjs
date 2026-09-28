#!/usr/bin/env node
// Render only an Ops UI and loopback TLS sidecar for an already attested,
// isolated PG17 candidate. Never modifies the base project or production.
import { createHash, X509Certificate } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { constants, closeSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const fail = message => { throw new Error(message) }
const assert = (value, message) => { if (!value) fail(message) }
const fullId = /^[0-9a-f]{64}$/u
const digestRef = /^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[0-9a-f]{64}$/u
const sha = value => createHash('sha256').update(value).digest('hex')
const testMode = process.env.NODE_ENV === 'test' && process.env.VITEST === 'true' && process.env.OPS_SIDECAR_TEST_UNPROTECTED_FILES === 'true'

function protectedPath(path, kind, mode) {
  assert(typeof path === 'string' && path.startsWith('/') && resolve(path) === path && realpathSync(path) === path, 'sidecar input path must be canonical and absolute')
  const item = lstatSync(path)
  assert((kind === 'directory' ? item.isDirectory() : item.isFile()) && !item.isSymbolicLink() &&
    (testMode || item.uid === 0) && (mode === undefined ? (item.mode & 0o022) === 0 : (item.mode & 0o777) === mode), 'sidecar input ownership or mode is unsafe')
  for (let parent = dirname(path); parent !== '/'; parent = dirname(parent)) {
    const item = lstatSync(parent)
    assert(item.isDirectory() && !item.isSymbolicLink() && (testMode || item.uid === 0) && (item.mode & 0o022) === 0, 'sidecar input parent is unsafe')
  }
}

function readIdentity(path) {
  const rows = readFileSync(path, 'utf8').trim().split(/\r?\n/u).map(row => {
    const index = row.indexOf('=')
    assert(index > 0, 'candidate identity row is malformed')
    return [row.slice(0, index), row.slice(index + 1)]
  })
  const identity = Object.fromEntries(rows)
  assert(rows.length === Object.keys(identity).length && /^release-[A-Za-z0-9._-]{1,72}$/u.test(identity.release_id ?? '') &&
    /^[0-9a-f]{40}$/u.test(identity.git_sha ?? '') && /^sha256:[0-9a-f]{64}$/u.test(identity.source_sha256 ?? ''), 'candidate identity is invalid')
  return identity
}

export function validateOpsSidecarInputs({ compose, manifest, identity, images, attestation, containers, network, imageInspects, sidecarProject }) {
  const project = compose?.name
  const services = compose?.services ?? {}
  assert(/^merchant-demo-[a-z0-9][a-z0-9_-]{0,25}$/u.test(project ?? '') &&
    Object.keys(services).sort().join(',') === 'api,migrate,postgres,redis' &&
    compose.networks?.default?.name === `${project}_private` && compose.networks.default.external === false, 'base candidate Compose is not the isolated four-service project')
  assert(/^merchant-ops-review-[a-z0-9][a-z0-9_-]{0,30}$/u.test(sidecarProject ?? '') && sidecarProject !== project, 'sidecar project is invalid')
  assert(manifest?.schema === 'isolated-demo-candidate/1' && manifest.deployment_scope === 'isolated_four_service_candidate' &&
    manifest.release_id === identity.release_id && manifest.release_git_sha === identity.git_sha &&
    manifest.source_sha256 === identity.source_sha256 && manifest.migration_target === 255 &&
    Array.isArray(manifest.public_ports) && manifest.public_ports.length === 0, 'base candidate manifest or migration 255 differs')
  assert(attestation?.schema === 'ecs-demo-isolated-runtime-attestation/1' && attestation.status === 'review_only' &&
    attestation.scope === 'isolated' && attestation.production_go === false && attestation.project === project &&
    attestation.release_id === identity.release_id && attestation.git_sha === identity.git_sha &&
    attestation.postgres?.migration_prefix === 255 && attestation.postgres?.roles_verified === true &&
    attestation.postgres?.workspace_rls?.verified === true, 'isolated PG17 attestation is missing or differs')
  assert(services.api.image === images.image_references?.['merchant-api'] && digestRef.test(services.api.image) &&
    /(?:^|\/)postgres:17-alpine@sha256:[0-9a-f]{64}$/u.test(services.postgres.image ?? '') &&
    manifest.image_references?.['postgres-migration'] === services.postgres.image &&
    manifest.image_references?.['candidate-redis'] === services.redis.image, 'base image set differs')
  assert(images.schema_version === 1 && images.release_id === identity.release_id && images.release_git_sha === identity.git_sha &&
    images.source_sha256 === identity.source_sha256 &&
    Object.keys(images.image_references ?? {}).sort().join(',') === ['merchant-api', 'merchant-worker', 'merchant-ui', 'merchant-ops-ui', 'payment-gateway', 'pilot-gateway'].sort().join(',') &&
    Object.entries(images.image_references).every(([name, ref]) => digestRef.test(ref) && ref.split('@')[1] === images.image_digests?.[name]), 'six-image manifest is not exact and digest-pinned')
  assert(Object.entries(images.image_references).every(([name, ref]) => manifest.image_references?.[name] === ref), 'base eight-image set differs from six-image manifest')
  assert(services.api.environment?.RELEASE_ID === identity.release_id && services.api.environment.RELEASE_GIT_SHA === identity.git_sha &&
    services.api.environment.RELEASE_MANIFEST_SHA256 === attestation.manifest_sha256?.replace(/^sha256:/u, '') &&
    services.api.environment.RELEASE_IMAGE_SET_DIGEST === compose['x-eight-image-set-digest'], 'base API release identity differs')
  for (const [service, container] of Object.entries(containers)) {
    assert(['api', 'postgres', 'redis'].includes(service) && fullId.test(container?.Id ?? '') &&
      container.Id === attestation.containers?.[service]?.container_id && container.State?.Running === true &&
      container.Image === attestation.containers?.[service]?.image_id &&
      container.Config?.Labels?.['com.docker.compose.project'] === project &&
      container.Config?.Labels?.['com.docker.compose.service'] === service &&
      !Object.values(container.HostConfig?.PortBindings ?? {}).some(binding => binding?.length) &&
      Object.keys(container.NetworkSettings?.Networks ?? {}).join(',') === `${project}_private`, 'base runtime container isolation differs')
  }
  assert(Object.keys(containers).sort().join(',') === 'api,postgres,redis' && network?.Name === `${project}_private` &&
    network.Labels?.['com.docker.compose.project'] === project &&
    Object.keys(network.Containers ?? {}).sort().join(',') === Object.values(containers).map(value => value.Id).sort().join(','), 'base candidate network has unexpected endpoints')
  assert(containers.api.Config.Labels['com.storenova.release.id'] === identity.release_id &&
    containers.api.Config.Labels['org.opencontainers.image.revision'] === identity.git_sha &&
    containers.api.Config.Labels['com.storenova.release.source_sha256'] === identity.source_sha256, 'base API image labels differ')
  for (const name of ['merchant-ops-ui', 'pilot-gateway']) {
    const image = imageInspects?.[name]
    assert(image?.Id?.startsWith('sha256:') && image.RepoDigests?.includes(images.image_references[name]) &&
      image.Config?.Labels?.['com.storenova.release.id'] === identity.release_id &&
      image.Config?.Labels?.['org.opencontainers.image.revision'] === identity.git_sha &&
      image.Config?.Labels?.['com.storenova.release.source_sha256'] === identity.source_sha256, `${name} image identity differs`)
  }
  assert(imageInspects['merchant-ops-ui'].Config.Labels['com.storenova.ops.auth_mode'] === 'password', 'candidate Ops UI must use password authentication')
  return { baseProject: project, networkName: network.Name }
}

export function candidateOpsReviewTlsConfig() {
  const headers = 'proxy_set_header Host $http_host; proxy_set_header X-Forwarded-Host $http_host; proxy_set_header X-Forwarded-Proto https; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;'
  return `server {
  listen 8080;
  server_name _;
  location = /healthz { access_log off; default_type text/plain; return 200 "ok\\n"; }
  location / { return 404; }
}
server {
  listen 8443 ssl;
  server_name ops.yxsona.com;
  server_tokens off;
  ssl_certificate /etc/nginx/certs/fullchain.pem;
  ssl_certificate_key /etc/nginx/certs/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  add_header Cache-Control "no-store" always;
  location = /releasez { proxy_pass http://api:8787/releasez; ${headers} }
  location = /healthz { proxy_pass http://api:8787/healthz; ${headers} }
  location = /api/mcp { client_max_body_size 70m; proxy_read_timeout 120s; proxy_pass http://api:8787/mcp; ${headers} }
  location = /api/v1/assets/upload { client_max_body_size 70m; proxy_pass http://api:8787/v1/assets/upload; ${headers} }
  location ^~ /api/ { client_max_body_size 1m; rewrite ^/api/(.*)$ /$1 break; proxy_pass http://api:8787; ${headers} }
  location = /ops { return 308 /ops/; }
  location ^~ /ops/ { proxy_pass http://ops-ui:8080/; ${headers} }
  location / { return 404; }
}\n`
}

export function createOpsSidecarCompose({ networkName, sidecarProject, images, identity, certDir, configPath }) {
  const labels = { 'com.storenova.release.id': identity.release_id, 'org.opencontainers.image.revision': identity.git_sha,
    'com.storenova.release.source_sha256': identity.source_sha256, 'com.storenova.candidate.scope': 'isolated-ops-review' }
  return { name: sidecarProject, services: {
    'ops-ui': { image: images.image_references['merchant-ops-ui'], restart: 'no', labels,
      environment: { OPS_API_UPSTREAM: 'http://api:8787', OPS_API_RESOLVER: '127.0.0.11' }, expose: ['8080'],
      networks: { candidate: { aliases: ['ops-ui'] } },
      healthcheck: { test: ['CMD-SHELL', 'wget -qO- http://127.0.0.1:8080/healthz >/dev/null && wget -qO- http://127.0.0.1:8080/api/healthz >/dev/null || exit 1'], interval: '10s', timeout: '3s', retries: 6, start_period: '15s' } },
    'review-gateway': { image: images.image_references['pilot-gateway'], restart: 'no', labels,
      depends_on: { 'ops-ui': { condition: 'service_healthy' } },
      ports: [{ target: 8443, published: 18445, host_ip: '127.0.0.1', protocol: 'tcp' }],
      healthcheck: { test: ['CMD-SHELL', "wget --no-check-certificate --header='Host: ops.yxsona.com' -qO- https://127.0.0.1:8443/healthz >/dev/null || exit 1"], interval: '10s', timeout: '3s', retries: 5 },
      volumes: [{ type: 'bind', source: configPath, target: '/etc/nginx/templates/default.conf.template', read_only: true },
        { type: 'bind', source: certDir, target: '/etc/nginx/certs', read_only: true }],
      networks: { candidate: {} } },
  }, networks: { candidate: { external: true, name: networkName } } }
}

function docker(args) {
  // The command output is parsed but never returned raw: inspection may include secrets.
  return JSON.parse(execFileSync('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', ...args], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin' },
  }))
}

function exclusive(path, contents) {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600)
  try { writeFileSync(fd, contents) } finally { closeSync(fd) }
}

export function render(argv = process.argv.slice(2)) {
  const names = new Set(['base-compose', 'base-manifest', 'base-identity', 'base-attestation', 'release-images', 'cert-dir', 'output-dir', 'sidecar-project'])
  const args = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.startsWith('--') ? argv[index].slice(2) : ''
    assert(names.has(name) && argv[index + 1] && !Object.hasOwn(args, name), 'invalid sidecar argument')
    args[name] = argv[index + 1]
  }
  assert(Object.keys(args).length === names.size, 'sidecar renderer arguments are incomplete')
  for (const name of ['base-compose', 'base-manifest', 'base-identity', 'base-attestation', 'release-images']) protectedPath(args[name], 'file', 0o600)
  protectedPath(args['cert-dir'], 'directory')
  protectedPath(args['output-dir'], 'directory', 0o700)
  protectedPath(join(args['cert-dir'], 'fullchain.pem'), 'file')
  protectedPath(join(args['cert-dir'], 'privkey.pem'), 'file', 0o600)
  const certificate = new X509Certificate(readFileSync(join(args['cert-dir'], 'fullchain.pem')))
  assert(certificate.checkHost('ops.yxsona.com') && Date.parse(certificate.validTo) > Date.now(), 'certificate does not cover ops.yxsona.com')
  const compose = JSON.parse(readFileSync(args['base-compose'], 'utf8'))
  const manifestBytes = readFileSync(args['base-manifest'])
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  const identity = readIdentity(args['base-identity'])
  const images = JSON.parse(readFileSync(args['release-images'], 'utf8'))
  const attestation = JSON.parse(readFileSync(args['base-attestation'], 'utf8'))
  assert(attestation.manifest_sha256 === `sha256:${sha(manifestBytes)}`, 'base attestation manifest digest differs')
  const project = compose.name
  const baseIds = Object.fromEntries(['api', 'postgres', 'redis'].map(name => [name, attestation.containers?.[name]?.container_id]))
  assert(Object.values(baseIds).every(id => fullId.test(id ?? '')), 'base attestation container IDs are missing')
  const containers = Object.fromEntries(Object.entries(baseIds).map(([name, id]) => [name, docker(['inspect', '--type', 'container', id])[0]]))
  const network = docker(['network', 'inspect', `${project}_private`])[0]
  const imageInspects = Object.fromEntries(['merchant-ops-ui', 'pilot-gateway'].map(name => [name, docker(['image', 'inspect', images.image_references[name]])[0]]))
  const { networkName } = validateOpsSidecarInputs({ compose, manifest, identity, images, attestation, containers, network, imageInspects, sidecarProject: args['sidecar-project'] })
  const output = args['output-dir']
  const configPath = join(output, 'ops-review-nginx.conf')
  const composePath = join(output, 'ops-review.compose.json')
  for (const path of [configPath, composePath]) {
    try { lstatSync(path); fail('sidecar output already exists') }
    catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
  const sidecar = createOpsSidecarCompose({ networkName, sidecarProject: args['sidecar-project'], images, identity,
    certDir: args['cert-dir'], configPath })
  assert(sidecar.services['ops-ui'].ports === undefined && sidecar.services['review-gateway'].ports[0].host_ip === '127.0.0.1', 'sidecar port isolation differs')
  exclusive(configPath, candidateOpsReviewTlsConfig())
  exclusive(composePath, `${JSON.stringify(sidecar, null, 2)}\n`)
  return { status: 'rendered_only', project: args['sidecar-project'], base_project: project, release_id: identity.release_id,
    git_sha: identity.git_sha, network: networkName, loopback_tls_port: 18445, compose: composePath, nginx: configPath }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(render())) }
  catch (error) { console.error(`isolated Ops sidecar rejected: ${error.message}`); process.exitCode = 1 }
}
