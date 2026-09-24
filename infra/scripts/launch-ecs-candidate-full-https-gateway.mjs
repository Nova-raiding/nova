#!/usr/bin/env node
// Run the immutable full HTTPS gateway on a candidate Compose network while
// publishing TLS only on host loopback. The production 80/443 listener is not
// changed, and the image's baked nginx configuration is never overridden.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertCandidateReleaseIdentity } from './launch-ecs-candidate-tls-gateway.mjs'

const fullId = /^[0-9a-f]{64}$/u
const imageRefPattern = /^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$/u
const releasePattern = /^[A-Za-z0-9._-]{1,80}$/u
const projectPattern = /^[a-z0-9][a-z0-9_-]{0,62}$/u
const networkPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u
const UPSTREAMS = Object.freeze(['api-replica', 'ui', 'ops-ui', 'payment-gateway'])
const CERT_MOUNT_TARGET = '/etc/nginx/certs'

function assert(ok, message) { if (!ok) throw new Error(message) }

function expectedIdentity(compose, project, releaseId, gatewayImageRef) {
  const services = compose?.services ?? {}
  const api = services['api-replica']
  const gateway = services['pilot-gateway']
  const network = compose?.networks?.default?.name
  const environment = api?.environment ?? {}
  const identity = {
    releaseId: environment.RELEASE_ID,
    gitSha: environment.RELEASE_GIT_SHA,
    manifestSha256: environment.RELEASE_MANIFEST_SHA256,
    imageSetDigest: environment.RELEASE_IMAGE_SET_DIGEST,
  }
  assert(projectPattern.test(project ?? ''), 'candidate Compose project is invalid')
  assert(releasePattern.test(releaseId ?? ''), 'candidate release ID is invalid')
  assert(networkPattern.test(network ?? '') && network === `${project}_default`,
    "candidate Compose default network must be the project's isolated default network")
  assert(identity.releaseId === releaseId && /^[0-9a-f]{40}$/u.test(identity.gitSha ?? '') &&
    /^[0-9a-f]{64}$/u.test(identity.manifestSha256 ?? '') &&
    /^sha256:[0-9a-f]{64}$/u.test(identity.imageSetDigest ?? ''), 'candidate Compose release identity is incomplete')
  assert(gateway?.image === gatewayImageRef && imageRefPattern.test(gatewayImageRef ?? ''), 'candidate HTTPS gateway image is not the frozen digest')
  for (const name of UPSTREAMS) assert(imageRefPattern.test(services[name]?.image ?? ''), `${name} image must be immutable`)
  const ports = gateway?.ports ?? []
  const expectedPorts = new Set(['8080:80', '8443:443'])
  const actualPorts = ports.map(port => `${port.target}:${String(port.published)}`)
  assert(actualPorts.length === 2 && actualPorts.every(value => expectedPorts.has(value)) && new Set(actualPorts).size === 2,
    'frozen full HTTPS gateway must declare only HTTP 80 and HTTPS 443 targets')
  return { ...identity, project, network, gatewayImageRef }
}

export function assertCandidateUpstream(container, { id, imageId, project, service, network, networkId }) {
  const labels = container?.Config?.Labels ?? {}
  const endpoint = container?.NetworkSettings?.Networks?.[network]
  const aliases = endpoint?.Aliases ?? []
  if (!fullId.test(id ?? '') || container?.Id !== id || container.Image !== imageId ||
      container.State?.Running !== true || labels['com.docker.compose.project'] !== project ||
      labels['com.docker.compose.service'] !== service || labels['com.docker.compose.oneoff'] === 'True' ||
      endpoint?.NetworkID !== networkId || !aliases.includes(service) ||
      Object.values(container?.HostConfig?.PortBindings ?? {}).some(value => (value ?? []).length > 0)) {
    throw new Error(`candidate ${service} identity or network mismatch`)
  }
}

export function assertCandidateFullGateway(container, { id, imageId, imageRef, name, project, releaseId, network, networkId, port, certDir }) {
  const bindings = container?.HostConfig?.PortBindings ?? {}
  const ports = Object.entries(bindings).flatMap(([target, values]) => (values ?? []).map(value => ({ target, ...value })))
  const endpoint = container?.NetworkSettings?.Networks?.[network]
  const mounts = container?.Mounts ?? []
  const labels = container?.Config?.Labels ?? {}
  if (!fullId.test(id ?? '') || container?.Id !== id || container.Image !== imageId ||
      container.Config?.Image !== imageRef || container.Name !== `/${name}` ||
      container.State?.Running !== true || labels['com.storenova.candidate.full-https-gateway'] !== 'true' ||
      labels['com.storenova.candidate.project'] !== project || labels['com.storenova.candidate.release-id'] !== releaseId ||
      labels['com.storenova.candidate.network-id'] !== networkId ||
      !endpoint || endpoint.NetworkID !== networkId || Object.keys(container.NetworkSettings?.Networks ?? {}).length !== 1 ||
      ports.length !== 1 || ports[0].target !== '8443/tcp' || ports[0].HostIp !== '127.0.0.1' || ports[0].HostPort !== String(port) ||
      container.HostConfig?.NetworkMode !== network || mounts.length !== 1 ||
      mounts[0].Type !== 'bind' || mounts[0].Source !== certDir || mounts[0].Destination !== CERT_MOUNT_TARGET || mounts[0].RW !== false) {
    throw new Error('candidate full HTTPS gateway identity, network, certificate mount or loopback port mismatch')
  }
}

function protectedFile(path) {
  assert(typeof path === 'string' && path.startsWith('/') && realpathSync(path) === path,
    'candidate path must be canonical and absolute')
  const info = statSync(path)
  const test = process.env.NODE_ENV === 'test' && process.env.VITEST === 'true' &&
    process.env.CANDIDATE_FULL_GATEWAY_TEST_UNPROTECTED_FILES === 'true'
  assert(info.isFile() && (test || (info.uid === 0 && (info.mode & 0o777) === 0o600)),
    'candidate inputs must be root-owned mode 0600')
  let parent = dirname(path)
  while (!test && parent !== '/') {
    const directory = statSync(parent)
    assert(directory.isDirectory() && directory.uid === 0 && (directory.mode & 0o022) === 0,
      'candidate input parent chain is not protected')
    parent = dirname(parent)
  }
}

function docker(binary, args) {
  const result = spawnSync(binary, ['--host', 'unix:///var/run/docker.sock', ...args], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Do not relay Docker/Compose diagnostics, which can contain resolved config.
  if (result.error || result.status !== 0) throw new Error('candidate full gateway Docker operation failed')
  return result.stdout.trim()
}

function inspect(binary, id) {
  const value = JSON.parse(docker(binary, ['inspect', '--type', 'container', id]))?.[0]
  assert(fullId.test(value?.Id ?? ''), 'candidate gateway inspection has no full ID')
  return value
}

function probe(port, identity) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, servername: 'yxsona.com', path: '/releasez', method: 'GET',
      headers: { Host: 'yxsona.com' }, rejectUnauthorized: true, timeout: 5000 }, response => {
      const chunks = []; let length = 0
      response.on('data', chunk => {
        length += chunk.length
        if (length > 1024 * 1024) req.destroy(new Error('candidate release probe exceeded limit'))
        else chunks.push(chunk)
      })
      response.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (response.statusCode !== 200) throw new Error('candidate release probe failed')
          assertCandidateReleaseIdentity(value, identity)
          resolve()
        } catch (error) { reject(error) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('candidate TLS probe timed out')))
    req.on('error', reject)
    req.end()
  })
}

function requireTestOnlyOverrides() {
  const test = process.env.NODE_ENV === 'test' && process.env.VITEST === 'true'
  if ((process.env.CANDIDATE_FULL_GATEWAY_TEST_DOCKER_BINARY || process.env.CANDIDATE_FULL_GATEWAY_TEST_CERT_DIR ||
       process.env.CANDIDATE_FULL_GATEWAY_TEST_SKIP_PROBE || process.env.CANDIDATE_FULL_GATEWAY_TEST_UNPROTECTED_FILES) && !test) {
    throw new Error('candidate full gateway test overrides are test-only')
  }
  return test
}

function findService(binary, project, service) {
  const ids = docker(binary, ['ps', '-a', '-q', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', `label=com.docker.compose.service=${service}`]).split(/\s+/u).filter(Boolean)
  assert(ids.length === 1 && fullId.test(ids[0]), `candidate ${service} must have exactly one container`)
  return inspect(binary, ids[0])
}

function verifyUpstreams(binary, compose, identity, networkId) {
  for (const service of UPSTREAMS) {
    const container = findService(binary, identity.project, service)
    const expectedImageId = docker(binary, ['image', 'inspect', '--format', '{{.Id}}', compose.services[service].image])
    assert(/^sha256:[0-9a-f]{64}$/u.test(expectedImageId), `candidate ${service} image is unavailable`)
    assertCandidateUpstream(container, { id: container.Id, imageId: expectedImageId, project: identity.project,
      service, network: identity.network, networkId })
  }
}

async function main() {
  const [action, composePath, envPath, project, gatewayImageRef, releaseId, portText, gatewayId] = process.argv.slice(2)
  assert(['start', 'stop'].includes(action), 'action must be start or stop')
  assert(projectPattern.test(project ?? '') && releasePattern.test(releaseId ?? '') &&
    imageRefPattern.test(gatewayImageRef ?? ''), 'candidate full gateway arguments are invalid')
  assert(/^\d{4,5}$/u.test(portText ?? '') && Number(portText) >= 1024 && Number(portText) <= 65535,
    'TLS loopback port must be an integer from 1024 through 65535')
  if (action === 'start') assert(gatewayId === undefined, 'start does not accept a gateway ID')
  else assert(fullId.test(gatewayId ?? ''), 'stop requires the full gateway Docker ID')
  const test = requireTestOnlyOverrides()
  const binary = process.env.CANDIDATE_FULL_GATEWAY_TEST_DOCKER_BINARY || '/usr/bin/docker'
  protectedFile(composePath); protectedFile(envPath)
  const compose = JSON.parse(readFileSync(composePath, 'utf8'))
  const identity = expectedIdentity(compose, project, releaseId, gatewayImageRef)
  const port = Number(portText)
  const certDir = process.env.CANDIDATE_FULL_GATEWAY_TEST_CERT_DIR || '/opt/merchant-deploy/deploy/certs'
  assert(realpathSync(certDir) === certDir, 'candidate TLS certificate directory must be canonical')
  const certDirectory = statSync(certDir)
  assert(certDirectory.isDirectory() && (test || (certDirectory.uid === 0 && (certDirectory.mode & 0o022) === 0)),
    'candidate TLS certificate directory must be protected')
  for (const file of ['fullchain.pem', 'privkey.pem']) {
    const path = `${certDir}/${file}`
    const resolved = realpathSync(path)
    assert(resolved.startsWith(`${certDir}/`) && statSync(resolved).isFile(),
      'candidate TLS certificate files must resolve to regular files inside the mounted directory')
  }
  const networkInfo = JSON.parse(docker(binary, ['network', 'inspect', identity.network]))?.[0]
  const networkId = networkInfo?.Id
  assert(fullId.test(networkId ?? '') && networkInfo?.Driver === 'bridge' && networkInfo?.Scope === 'local',
    'candidate Compose network must be a local bridge network')
  const imageId = docker(binary, ['image', 'inspect', '--format', '{{.Id}}', gatewayImageRef])
  assert(/^sha256:[0-9a-f]{64}$/u.test(imageId), 'candidate HTTPS gateway image is unavailable')

  if (action === 'stop') {
    const container = inspect(binary, gatewayId)
    const name = container.Name?.replace(/^\//u, '')
    assert(name?.startsWith(`merchant-candidate-full-https-${releaseId}-`), 'container is not this candidate full HTTPS gateway')
    assertCandidateFullGateway(container, { id: gatewayId, imageId, imageRef: gatewayImageRef, name, project, releaseId,
      network: identity.network, networkId, port, certDir })
    if (container.State?.Running === true) docker(binary, ['stop', '--time', '10', gatewayId])
    console.log(gatewayId)
    return
  }

  verifyUpstreams(binary, compose, identity, networkId)
  const name = `merchant-candidate-full-https-${releaseId}-${randomBytes(5).toString('hex')}`
  const started = docker(binary, ['run', '--detach', '--pull', 'never', '--name', name,
    '--network', identity.network, '--publish', `127.0.0.1:${port}:8443`,
    '--label', 'com.storenova.candidate.full-https-gateway=true',
    '--label', `com.storenova.candidate.project=${project}`,
    '--label', `com.storenova.candidate.release-id=${releaseId}`,
    '--label', `com.storenova.candidate.network-id=${networkId}`,
    '--mount', `type=bind,src=${certDir},dst=${CERT_MOUNT_TARGET},readonly`, gatewayImageRef])
  assert(fullId.test(started), 'candidate Docker run returned no full gateway ID')
  let container
  try { container = inspect(binary, started) }
  catch {
    docker(binary, ['stop', '--time', '10', started])
    throw new Error('candidate full HTTPS gateway inspection failed')
  }
  try {
    assertCandidateFullGateway(container, { id: started, imageId, imageRef: gatewayImageRef, name, project, releaseId,
      network: identity.network, networkId, port, certDir })
    if (!test || !process.env.CANDIDATE_FULL_GATEWAY_TEST_SKIP_PROBE) {
      let lastError
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try { await probe(port, identity); lastError = undefined; break }
        catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 500)) }
      }
      if (lastError) throw lastError
    }
  } catch {
    if (container.Id === started && container.State?.Running === true) docker(binary, ['stop', '--time', '10', started])
    throw new Error('candidate full HTTPS gateway failed identity, isolation or TLS release verification')
  }
  console.log(started)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'candidate full HTTPS gateway failed'); process.exitCode = 1 })
}
