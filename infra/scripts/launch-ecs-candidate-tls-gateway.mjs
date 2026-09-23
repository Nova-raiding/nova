#!/usr/bin/env node
// Isolated, loopback-only TLS route for a frozen candidate API. Never touches
// the production 80/443 gateway or publishes the candidate API directly.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { constants, openSync, closeSync, chmodSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:https'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fullId = /^[0-9a-f]{64}$/
const imageRefPattern = /^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$/
const releasePattern = /^[A-Za-z0-9._-]{1,80}$/
const projectPattern = /^[a-z0-9][a-z0-9_-]{0,39}$/

export function candidateGatewayConfig(ip) {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) || ip.split('.').some(part => Number(part) > 255)) throw new Error('candidate API has no valid IPv4 address')
  const upstream = `http://${ip}:8787`
  return `server {
  listen 8443 ssl;
  server_name yxsona.com;
  server_tokens off;
  ssl_certificate /etc/nginx/certs/fullchain.pem;
  ssl_certificate_key /etc/nginx/certs/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  client_max_body_size 1m;
  add_header Cache-Control "no-store" always;
  location = /releasez {
    limit_except GET { deny all; }
    proxy_pass ${upstream}/releasez;
    proxy_set_header Host yxsona.com;
    proxy_set_header X-Forwarded-Host yxsona.com;
    proxy_set_header X-Forwarded-Proto https;
  }
  location = /mcp {
    limit_except POST { deny all; }
    client_max_body_size 70m;
    proxy_pass ${upstream}/mcp;
    proxy_http_version 1.1;
    proxy_set_header Host yxsona.com;
    proxy_set_header X-Forwarded-Host yxsona.com;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-MCP-OAuth-Required "true";
  }
  location = /v1/auth/mcp-token/refresh {
    limit_except POST { deny all; }
    proxy_pass ${upstream}/v1/auth/mcp-token/refresh;
    proxy_http_version 1.1;
    proxy_set_header Host yxsona.com;
    proxy_set_header X-Forwarded-Host yxsona.com;
    proxy_set_header X-Forwarded-Proto https;
  }
  location / { return 404; }
}\n`
}

export function assertCandidateApi(container, { id, imageId, project, releaseId, network }) {
  const labels = container?.Config?.Labels ?? {}
  const bindings = container?.HostConfig?.PortBindings ?? {}
  const address = container?.NetworkSettings?.Networks?.[network]?.IPAddress
  if (container?.Id !== id || container.Image !== imageId || container.State?.Running !== true ||
      labels['com.docker.compose.project'] !== project || labels['com.docker.compose.service'] !== 'api' ||
      labels['com.docker.compose.oneoff'] !== 'True' ||
      !container.Name?.replace(/^\//, '').startsWith(`merchant-candidate-api-${releaseId}-`) ||
      Object.values(bindings).some(value => value?.length) || !address) throw new Error('candidate API identity or isolation mismatch')
  candidateGatewayConfig(address)
  return address
}

export function assertCandidateGateway(container, { id, imageId, name, network, port, apiId }) {
  const bindings = container?.HostConfig?.PortBindings ?? {}
  const ports = Object.entries(bindings)
  const list = bindings['8443/tcp']
  if (container?.Id !== id || container.Image !== imageId || container.State?.Running !== true ||
      container.Name !== `/${name}` || !container.NetworkSettings?.Networks?.[network] ||
      ports.length !== 1 || !Array.isArray(list) || list.length !== 1 ||
      list[0]?.HostIp !== '127.0.0.1' || list[0]?.HostPort !== String(port) ||
      container.Config?.Labels?.['com.storenova.candidate.api-id'] !== apiId) {
    throw new Error('candidate TLS gateway identity or port isolation mismatch')
  }
}

function fail(message) { console.error(message); process.exitCode = 1 }
function protectedFile(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || realpathSync(path) !== path) throw new Error('candidate path must be canonical and absolute')
  const info = statSync(path)
  const test = process.env.NODE_ENV === 'test' && process.env.VITEST === 'true' && process.env.CANDIDATE_TLS_TEST_UNPROTECTED_FILES === 'true'
  if (!info.isFile() || (!test && (info.uid !== 0 || (info.mode & 0o777) !== 0o600))) throw new Error('candidate input must be root-owned mode 0600')
  let parent = dirname(path)
  while (!test && parent !== '/') {
    const directory = statSync(parent)
    if (!directory.isDirectory() || directory.uid !== 0 || (directory.mode & 0o022)) throw new Error('candidate parent chain is not protected')
    parent = dirname(parent)
  }
}
function docker(binary, args) {
  const result = spawnSync(binary, ['--host', 'unix:///var/run/docker.sock', ...args], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Docker errors may echo resolved environment. Do not forward either stream.
  if (result.error || result.status !== 0) throw new Error('candidate Docker operation failed')
  return result.stdout.trim()
}
function inspect(binary, id) {
  const value = JSON.parse(docker(binary, ['inspect', '--type', 'container', id]))?.[0]
  if (!fullId.test(value?.Id ?? '')) throw new Error('candidate Docker inspection has no full ID')
  return value
}
function probe(port, releaseId, gitSha, imageSetDigest) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, servername: 'yxsona.com', path: '/releasez', method: 'GET',
      headers: { Host: 'yxsona.com' }, rejectUnauthorized: true, timeout: 5000 }, res => {
      const chunks = []; let length = 0
      res.on('data', chunk => { length += chunk.length; if (length > 1024 * 1024) req.destroy(new Error('candidate release probe exceeded limit')); else chunks.push(chunk) })
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          const release = value?.data?.release
          if (res.statusCode !== 200 || value?.data?.ready !== true || release?.release_id !== releaseId ||
              release?.release_git_sha !== gitSha || release?.image_set_digest !== imageSetDigest) throw new Error('candidate release identity mismatch')
          resolve()
        } catch (error) { reject(error) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('candidate TLS probe timed out')))
    req.on('error', reject)
    req.end()
  })
}

async function main() {
  const [action, composePath, envPath, project, gatewayImageRef, releaseId, apiId, portText, gatewayId] = process.argv.slice(2)
  if (!['start', 'stop'].includes(action) || !projectPattern.test(project ?? '') || !releasePattern.test(releaseId ?? '') ||
      !imageRefPattern.test(gatewayImageRef ?? '') || !fullId.test(apiId ?? '') ||
      !/^(?:1[0-9]{3}|[2-9][0-9]{3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/.test(portText ?? '')) throw new Error('candidate TLS gateway arguments are invalid')
  if (action === 'start' && gatewayId !== undefined || action === 'stop' && !fullId.test(gatewayId ?? '')) throw new Error('start/stop gateway ID mismatch')
  const test = process.env.NODE_ENV === 'test' && process.env.VITEST === 'true'
  if ((process.env.CANDIDATE_TLS_TEST_DOCKER_BINARY || process.env.CANDIDATE_TLS_TEST_CERT_DIR || process.env.CANDIDATE_TLS_TEST_SKIP_PROBE || process.env.CANDIDATE_TLS_TEST_UNPROTECTED_FILES) && !test) throw new Error('candidate TLS test overrides are test-only')
  const binary = process.env.CANDIDATE_TLS_TEST_DOCKER_BINARY || '/usr/bin/docker'
  protectedFile(composePath); protectedFile(envPath)
  const compose = JSON.parse(readFileSync(composePath, 'utf8'))
  const api = compose?.services?.api
  const gateway = compose?.services?.['pilot-gateway']
  const network = compose?.networks?.default?.name
  const gitSha = api?.environment?.RELEASE_GIT_SHA
  const imageSetDigest = api?.environment?.RELEASE_IMAGE_SET_DIGEST
  if (gateway?.image !== gatewayImageRef || api?.environment?.RELEASE_ID !== releaseId ||
      !/^[0-9a-f]{40}$/.test(gitSha ?? '') || !/^sha256:[0-9a-f]{64}$/.test(imageSetDigest ?? '') ||
      !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(network ?? '')) throw new Error('candidate frozen Compose identity is incomplete')
  const imageId = docker(binary, ['image', 'inspect', '--format', '{{.Id}}', gatewayImageRef])
  if (!/^sha256:[0-9a-f]{64}$/.test(imageId) || !imageRefPattern.test(api?.image ?? '')) throw new Error('candidate image identities are invalid')
  const port = Number(portText)
  if (action === 'stop') {
    const container = inspect(binary, gatewayId)
    assertCandidateGateway(container, { id: gatewayId, imageId, name: container.Name?.slice(1), network, port, apiId })
    if (!container.Name?.startsWith(`/merchant-candidate-tls-${releaseId}-`)) throw new Error('candidate gateway name mismatch')
    docker(binary, ['stop', '--time', '10', gatewayId])
    console.log(gatewayId)
    return
  }
  const apiImageId = docker(binary, ['image', 'inspect', '--format', '{{.Id}}', api.image])
  if (!/^sha256:[0-9a-f]{64}$/.test(apiImageId)) throw new Error('candidate API image ID is invalid')
  const apiContainer = inspect(binary, apiId)
  const ip = assertCandidateApi(apiContainer, { id: apiId, imageId: apiImageId, project, releaseId, network })
  const certDir = process.env.CANDIDATE_TLS_TEST_CERT_DIR || '/opt/merchant-deploy/deploy/certs'
  if (realpathSync(certDir) !== certDir || !statSync(certDir).isDirectory() ||
      !statSync(join(certDir, 'fullchain.pem')).isFile() || !statSync(join(certDir, 'privkey.pem')).isFile()) throw new Error('candidate TLS certificate mount is unavailable')
  const name = `merchant-candidate-tls-${releaseId}-${randomBytes(5).toString('hex')}`
  const template = join(dirname(composePath), `${name}.conf`)
  const fd = openSync(template, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
  try { writeFileSync(fd, candidateGatewayConfig(ip)) } finally { closeSync(fd) }
  // A host umask of 077 is common; the unprivileged Nginx UID still needs to
  // read this non-secret template after Docker bind-mounts it into the container.
  chmodSync(template, 0o644)
  const started = docker(binary, ['run', '--detach', '--pull', 'never', '--no-healthcheck', '--name', name,
    '--network', network, '--publish', `127.0.0.1:${port}:8443`,
    '--label', `com.storenova.candidate.api-id=${apiId}`,
    '--mount', `type=bind,src=${template},dst=/etc/nginx/templates/default.conf.template,readonly`,
    '--mount', `type=bind,src=${certDir},dst=/etc/nginx/certs,readonly`, gatewayImageRef])
  if (!fullId.test(started)) throw new Error('candidate Docker run returned no full gateway ID')
  let container
  try { container = inspect(binary, started) }
  catch {
    // Docker run returned this newly-created exact ID, so stopping it does not
    // depend on finding a mutable name or scanning unrelated containers.
    docker(binary, ['stop', '--time', '10', started])
    throw new Error('candidate TLS gateway inspection failed')
  }
  try {
    assertCandidateGateway(container, { id: started, imageId, name, network, port, apiId })
    if (!process.env.CANDIDATE_TLS_TEST_SKIP_PROBE) {
      let lastError
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try { await probe(port, releaseId, gitSha, imageSetDigest); lastError = null; break }
        catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 500)) }
      }
      if (lastError) throw lastError
    }
  } catch {
    if (container.Id === started && container.State?.Running === true) docker(binary, ['stop', '--time', '10', started])
    throw new Error('candidate TLS gateway failed identity, isolation or TLS release verification')
  }
  console.log(started)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch(error => fail(error instanceof Error ? error.message : 'candidate TLS gateway failed'))
}
