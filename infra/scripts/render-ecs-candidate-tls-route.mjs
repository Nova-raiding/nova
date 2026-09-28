#!/usr/bin/env node
// Render an independent, credential-free route manifest for an existing
// isolated four-service candidate. It never starts or changes containers.
import { spawnSync } from 'node:child_process'
import { constants, closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertCandidateApi } from './launch-ecs-candidate-tls-gateway.mjs'

const ID = /^[0-9a-f]{64}$/u
const SHA = /^[0-9a-f]{64}$/u
const IMAGE = /^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$/u
const fail = code => { throw new Error(`candidate TLS route: ${code}`) }

export function renderCandidateTlsRoute(source, images, apiContainer, apiImageId, gatewayImageId) {
  const project = source?.name, services = source?.services ?? {}, api = services.api
  const network = source?.networks?.default
  const releaseId = api?.environment?.RELEASE_ID
  const gitSha = api?.environment?.RELEASE_GIT_SHA
  const manifestSha256 = api?.environment?.RELEASE_MANIFEST_SHA256
  const imageSetDigest = api?.environment?.RELEASE_IMAGE_SET_DIGEST
  const sourceSha256 = api?.labels?.['com.storenova.release.source_sha256']
  if (!/^merchant-demo-[a-z0-9][a-z0-9_-]{0,25}$/u.test(project ?? '') ||
      !['api,migrate,postgres,redis', 'api,migrate,postgres,redis,ui'].includes(Object.keys(services).sort().join(',')) ||
      Object.keys(source.networks ?? {}).join(',') !== 'default' ||
      network?.name !== `${project}_private` || network?.external === true ||
      !/^release-[A-Za-z0-9._-]{1,80}$/u.test(releaseId ?? '') ||
      !/^[0-9a-f]{40}$/u.test(gitSha ?? '') || !SHA.test(manifestSha256 ?? '') ||
      !/^sha256:[0-9a-f]{64}$/u.test(imageSetDigest ?? '') ||
      !/^sha256:[0-9a-f]{64}$/u.test(sourceSha256 ?? '') ||
      source['x-eight-image-set-digest'] !== imageSetDigest ||
      Object.values(services).some(service => (service?.ports ?? []).length > 0)) fail('source identity or isolation mismatch')
  if (services.ui && (services.ui.image !== images?.image_references?.['merchant-ui'] ||
      images?.image_digests?.['merchant-ui'] !== services.ui.image.split('@')[1] ||
      services.ui.labels?.['org.opencontainers.image.revision'] !== gitSha ||
      services.ui.labels?.['com.storenova.release.source_sha256'] !== sourceSha256 ||
      !api.networks?.default?.aliases?.includes('merchant-api'))) fail('merchant UI candidate identity mismatch')
  if (images?.schema_version !== 1 || images.release_id !== releaseId ||
      images.release_git_sha !== gitSha || images.source_sha256 !== sourceSha256 ||
      !IMAGE.test(api.image ?? '') || api.image !== images.image_references?.['merchant-api'] ||
      !IMAGE.test(images.image_references?.['pilot-gateway'] ?? '') ||
      images.image_digests?.['merchant-api'] !== api.image.split('@')[1] ||
      images.image_digests?.['pilot-gateway'] !== images.image_references['pilot-gateway'].split('@')[1] ||
      !/^sha256:[0-9a-f]{64}$/u.test(apiImageId ?? '') ||
      !/^sha256:[0-9a-f]{64}$/u.test(gatewayImageId ?? '')) fail('image manifest mismatch')
  const routeBinding = {
    schema_version: 'ecs-candidate-tls-route/1', api_container_id: apiContainer?.Id,
    api_image_id: apiImageId, api_network_id: apiContainer?.NetworkSettings?.Networks?.[network.name]?.NetworkID,
    gateway_image_id: gatewayImageId, gateway_image_ref: images.image_references['pilot-gateway'],
    host: '127.0.0.1', port: 18443,
  }
  if (!ID.test(routeBinding.api_container_id ?? '') || !ID.test(routeBinding.api_network_id ?? '')) fail('runtime identity incomplete')
  assertCandidateApi(apiContainer, { id: routeBinding.api_container_id, imageId: apiImageId, project,
    releaseId, network: network.name, manifestProject: project, gitSha, sourceSha256, routeBinding })
  return {
    name: project,
    services: {
      api: { image: api.image,
        labels: { 'com.storenova.release.id': releaseId,
          'org.opencontainers.image.revision': gitSha,
          'com.storenova.release.source_sha256': sourceSha256 },
        environment: { RELEASE_ID: releaseId, RELEASE_GIT_SHA: gitSha,
          RELEASE_MANIFEST_SHA256: manifestSha256, RELEASE_IMAGE_SET_DIGEST: imageSetDigest } },
      'pilot-gateway': { image: routeBinding.gateway_image_ref },
    },
    networks: { default: { name: network.name, external: false } },
    x_candidate_tls_route: routeBinding,
  }
}

function protectedPath(path, kind, mode) {
  if (typeof path !== 'string' || !path.startsWith('/') || resolve(path) !== path || realpathSync(path) !== path) fail('path must be absolute and canonical')
  const stat = lstatSync(path)
  if (stat.uid !== 0 || stat.isSymbolicLink() || (stat.mode & 0o777) !== mode ||
      (kind === 'file' ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) fail('path owner, mode or type is unsafe')
  for (let parent = dirname(path); parent !== '/'; parent = dirname(parent)) {
    const ancestor = lstatSync(parent)
    if (ancestor.uid !== 0 || !ancestor.isDirectory() || ancestor.isSymbolicLink() || (ancestor.mode & 0o022) !== 0) fail('path ancestor is unsafe')
  }
}

function docker(args) {
  const result = spawnSync('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', ...args], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error || result.status !== 0) fail('read-only Docker inspection failed')
  return result.stdout.trim()
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length !== 8 || argv[0] !== '--source-compose' || argv[2] !== '--release-images' ||
      argv[4] !== '--api-id' || argv[6] !== '--output') fail('expected source Compose, image manifest, API ID and output path')
  const [, sourcePath, , imagesPath, , apiId, , outputPath] = argv
  if (!ID.test(apiId ?? '')) fail('full API container ID is required')
  protectedPath(sourcePath, 'file', 0o600)
  protectedPath(imagesPath, 'file', 0o600)
  protectedPath(dirname(outputPath), 'directory', 0o700)
  if (resolve(outputPath) !== outputPath || !outputPath.endsWith('.json')) fail('output path must be canonical JSON')
  const source = JSON.parse(readFileSync(sourcePath, 'utf8'))
  const images = JSON.parse(readFileSync(imagesPath, 'utf8'))
  const apiRef = source?.services?.api?.image, gatewayRef = images?.image_references?.['pilot-gateway']
  if (!IMAGE.test(apiRef ?? '') || !IMAGE.test(gatewayRef ?? '')) fail('immutable image references required')
  const apiImageId = docker(['image', 'inspect', '--format', '{{.Id}}', apiRef])
  const gatewayImageId = docker(['image', 'inspect', '--format', '{{.Id}}', gatewayRef])
  const apiContainer = JSON.parse(docker(['inspect', '--type', 'container', apiId]))?.[0]
  const route = renderCandidateTlsRoute(source, images, apiContainer, apiImageId, gatewayImageId)
  const fd = openSync(outputPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, `${JSON.stringify(route, null, 2)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
  console.log(JSON.stringify({ status: 'route_rendered', project: route.name,
    api_container_id: route.x_candidate_tls_route.api_container_id,
    gateway_image_ref: route.x_candidate_tls_route.gateway_image_ref,
    host: '127.0.0.1', port: 18443, output: outputPath }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main() } catch (error) { console.error(error instanceof Error ? error.message : 'candidate route render failed'); process.exitCode = 1 }
}
