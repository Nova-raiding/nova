// Candidate-only ChatGPT bridge transport. Import with `node --import` from a
// temporary acceptance copy of the plugin, never from the published package.
// The logical URL stays the canonical production origin. Only the socket is
// redirected through an SSH tunnel to an isolated TLS gateway on ECS.
import { request } from 'node:https'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const sha = /^sha256:[0-9a-f]{64}$/u
const gitSha = /^[0-9a-f]{40}$/u
const releaseId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

export function validateCandidateRoute(value, mcpBaseUrl) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('candidate route must be an object')
  const origin = new URL(value.origin)
  if (origin.protocol !== 'https:' || origin.origin !== value.origin || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash || origin.port) throw new Error('candidate route requires a canonical HTTPS origin')
  if (mcpBaseUrl !== value.origin) throw new Error('candidate route origin does not match MERCHANT_MCP_BASE_URL')
  if (value.loopback_host !== '127.0.0.1' || !Number.isInteger(value.loopback_port) || value.loopback_port < 1024 || value.loopback_port > 65535) throw new Error('candidate route requires a non-privileged loopback tunnel')
  if (!releaseId.test(value.expected_release_id ?? '') || !gitSha.test(value.expected_git_sha ?? '') || !sha.test(value.expected_image_set_digest ?? '')) throw new Error('candidate route requires frozen release identity')
  return Object.freeze({ ...value, hostname: origin.hostname })
}

export function assertCandidateRelease(value, route) {
  const observed = value?.data?.release
  if (value?.data?.ready !== true || observed?.release_id !== route.expected_release_id || observed?.release_git_sha !== route.expected_git_sha || observed?.image_set_digest !== route.expected_image_set_digest) throw new Error('candidate TLS route returned the wrong release identity')
}

export function readCandidateRoute(path, mcpBaseUrl) {
  if (!isAbsolute(path ?? '') || realpathSync(path) !== path) throw new Error('candidate route file must have a canonical absolute path')
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('candidate route file must be owner-only regular file')
  return validateCandidateRoute(JSON.parse(readFileSync(path, 'utf8')), mcpBaseUrl)
}

function tunnelRequest(route, url, init = {}, maxBytes = 70 * 1024 * 1024) {
  const target = new URL(url)
  if (target.origin !== route.origin || target.username || target.password || target.hash) return Promise.reject(new Error('candidate route refuses another origin'))
  if (!['/releasez', '/mcp', '/v1/auth/mcp-token/refresh'].includes(target.pathname)) return Promise.reject(new Error('candidate route refuses an unapproved path'))
  if (target.pathname === '/releasez' && init.method && init.method !== 'GET') return Promise.reject(new Error('candidate release probe must be GET'))
  if (target.pathname !== '/releasez' && init.method !== 'POST') return Promise.reject(new Error('candidate business request must be POST'))
  if (target.search) return Promise.reject(new Error('candidate route refuses query parameters'))
  return new Promise((resolve, reject) => {
    const headers = new Headers(init.headers)
    headers.set('host', route.hostname)
    const req = request({
      hostname: route.loopback_host, port: route.loopback_port, servername: route.hostname,
      path: target.pathname, method: init.method ?? 'GET', headers: Object.fromEntries(headers),
      rejectUnauthorized: true, timeout: 20_000,
    }, res => {
      if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400) { req.destroy(new Error('candidate route refuses redirect')); return }
      const chunks = []; let length = 0
      res.on('data', chunk => { length += chunk.length; if (length > maxBytes) req.destroy(new Error('candidate response exceeds limit')); else chunks.push(chunk) })
      res.on('end', () => {
        const status = res.statusCode ?? 0
        if (status < 200 || status > 599) { reject(new Error('candidate gateway returned invalid HTTP status')); return }
        if (status === 304) { reject(new Error('candidate gateway returned an unexpected 304')); return }
        const body = status === 204 || status === 205 ? null : Buffer.concat(chunks)
        resolve(new Response(body, { status, headers: res.headers }))
      })
    })
    req.on('timeout', () => req.destroy(new Error('candidate TLS route timed out')))
    req.on('error', reject)
    const abort = () => req.destroy(init.signal?.reason ?? new Error('candidate request aborted'))
    if (init.signal?.aborted) { abort(); return }
    init.signal?.addEventListener('abort', abort, { once: true })
    req.on('close', () => init.signal?.removeEventListener('abort', abort))
    if (init.body != null) req.write(init.body)
    req.end()
  })
}

export function installCandidateFetchRoute(route, transport = tunnelRequest) {
  const previous = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const target = new URL(url instanceof Request ? url.url : String(url))
    if (target.origin !== route.origin) throw new Error('candidate bridge tried to use an unapproved origin')
    // Release identity is checked before every authenticated request, so a
    // tunnel restart or DNS/name switch cannot silently send a bearer to the
    // old production API. TLS SNI and certificate checks remain enabled.
    const probe = await transport(route, `${route.origin}/releasez`, { method: 'GET' }, 1024 * 1024)
    if (!probe.ok) throw new Error('candidate TLS release probe failed')
    assertCandidateRelease(await probe.json(), route)
    return transport(route, target.href, init)
  }
  return () => { globalThis.fetch = previous }
}

if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
  const path = process.env.MERCHANT_CANDIDATE_ROUTE_FILE
  if (!path) throw new Error('MERCHANT_CANDIDATE_ROUTE_FILE is required for candidate transport')
  installCandidateFetchRoute(readCandidateRoute(path, process.env.MERCHANT_MCP_BASE_URL))
}
