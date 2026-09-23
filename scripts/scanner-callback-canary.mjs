import { createHash, randomBytes } from 'node:crypto'
import { deflateSync } from 'node:zlib'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async response => {
  const body = await response.json()
  if (!body || typeof body !== 'object') throw new Error('CANARY_RESPONSE_INVALID')
  return body
}
const requireValue = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return value.trim()
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, payload) {
  const tag = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(payload.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([tag, payload])))
  return Buffer.concat([length, tag, payload, checksum])
}

/** One valid, unique 1x1 PNG. Unique bytes avoid trusted-clean deduplication. */
export function canaryPng(nonce = randomBytes(3)) {
  if (!Buffer.isBuffer(nonce) || nonce.length !== 3) throw new Error('CANARY_NONCE_INVALID')
  const header = Buffer.from('89504e470d0a1a0a', 'hex')
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([header, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, ...nonce]))), chunk('IEND', Buffer.alloc(0))])
}

function canaryUrl(base, path) {
  const url = new URL(base)
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) throw new Error('CANARY_BASE_URL_INVALID')
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) throw new Error('CANARY_HTTPS_REQUIRED')
  const route = new URL(path, 'https://canary.invalid')
  url.pathname = `${url.pathname.replace(/\/$/u, '')}/${route.pathname.replace(/^\//u, '')}`
  url.search = route.search
  return url
}

function requireIdentity(envelope, expectedReleaseId, expectedSha) {
  const release = envelope?.data?.release
  if (release?.release_id !== expectedReleaseId || release?.release_git_sha !== expectedSha || envelope?.data?.ready !== true) throw new Error('CANARY_RELEASE_IDENTITY_MISMATCH')
  return release
}

function scannerSummary(envelope) {
  return envelope?.data?.scanner ?? envelope?.error?.details?.scanner
}

export function canaryAdmission(env, execute) {
  const baseUrl = requireValue(env.SCANNER_CANARY_API_BASE_URL, 'SCANNER_CANARY_API_BASE_URL')
  canaryUrl(baseUrl, '/releasez')
  const expectedReleaseId = requireValue(env.SCANNER_CANARY_RELEASE_ID, 'SCANNER_CANARY_RELEASE_ID')
  const expectedSha = requireValue(env.SCANNER_CANARY_RELEASE_GIT_SHA, 'SCANNER_CANARY_RELEASE_GIT_SHA')
  if (!/^[a-f0-9]{40}$/u.test(expectedSha)) throw new Error('SCANNER_CANARY_RELEASE_GIT_SHA must be a complete Git SHA')
  const workspaceId = requireValue(env.SCANNER_CANARY_WORKSPACE_ID, 'SCANNER_CANARY_WORKSPACE_ID')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(workspaceId)) throw new Error('SCANNER_CANARY_WORKSPACE_ID is invalid')
  if (execute) {
    if (env.SCANNER_CANARY_CONFIRM !== `${expectedReleaseId}:${workspaceId}`) throw new Error('SCANNER_CANARY_CONFIRM must exactly bind release and workspace')
    if (env.SCANNER_CANARY_WORKER_SCOPE_VERIFIED !== 'true') throw new Error('scanner worker workspace scope must be independently verified')
    if (env.SCANNER_CANARY_RECOVERY_VERIFIED !== 'true') throw new Error('scanner recovery capability must be independently verified')
    if (env.SCANNER_CANARY_ENTITLEMENT_VERIFIED !== 'true') throw new Error('canary workspace asset.upload entitlement must be independently verified')
    requireValue(env.SCANNER_CANARY_API_TOKEN, 'SCANNER_CANARY_API_TOKEN')
  }
  return { baseUrl, expectedReleaseId, expectedSha, workspaceId }
}

/** No production I/O is performed on import. Only --execute enables one upload. */
export async function runScannerCallbackCanary({ env = process.env, execute = false, fetchImpl = fetch, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), nonce = randomBytes(3) } = {}) {
  const admission = canaryAdmission(env, execute)
  const { baseUrl, expectedReleaseId, expectedSha, workspaceId } = admission
  const released = await json(await fetchImpl(canaryUrl(baseUrl, '/releasez'), { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000) }))
  requireIdentity(released, expectedReleaseId, expectedSha)
  if (!execute) return { status: 'dry_run', evidenceType: 'unsigned_observation', releaseId: expectedReleaseId, workspaceId, writes: 0, proof: false }

  // The scanner-specific /readyz may be 503 precisely because an old callback
  // expired. The worker's recovery path depends on /healthz (database + Redis),
  // so prove that dependency envelope before creating a quarantined asset.
  const healthResponse = await fetchImpl(canaryUrl(baseUrl, '/healthz'), { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000) })
  const health = await json(healthResponse)
  if (!healthResponse.ok || health.error != null || health.data?.persistence?.ready !== true || health.data?.redis?.ready !== true) {
    throw new Error('CANARY_API_HEALTH_BLOCKED')
  }

  // Only the stale/missing accepted-callback gate may be bypassed for the
  // recovery canary. Other readiness failures must stop before creating an
  // asset that the worker may not be able to process.
  const initialReadyResponse = await fetchImpl(canaryUrl(baseUrl, '/readyz'), { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000) })
  const initialReady = await json(initialReadyResponse)
  const callbackOnlyBlock = initialReadyResponse.status === 503 && initialReady.error?.code === 'SCANNER_NOT_READY'
  if (!callbackOnlyBlock && (!initialReadyResponse.ok || initialReady.error != null)) throw new Error('CANARY_READINESS_BLOCKED')

  const headers = { authorization: `Bearer ${env.SCANNER_CANARY_API_TOKEN}`, 'x-workspace-id': workspaceId }
  // A read proves this exact token can access this exact workspace, and checks
  // bounded storage headroom. It does not itself prove upload entitlement.
  const assetsResponse = await fetchImpl(canaryUrl(baseUrl, '/v1/assets?limit=1'), { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(10_000) })
  const assets = await json(assetsResponse)
  if (!assetsResponse.ok || assets.workspace_id !== workspaceId || !Array.isArray(assets.data?.items)
    || !Number.isSafeInteger(assets.data?.storage_quota?.availableBytes) || assets.data.storage_quota.availableBytes < 4096) throw new Error('CANARY_WORKSPACE_READ_OR_QUOTA_BLOCKED')
  const bytes = canaryPng(nonce)
  const digest = sha256(bytes)
  const uploadStartedAt = new Date(now()).toISOString()
  const name = `scanner-canary-${randomBytes(8).toString('hex')}.png`
  // Never retry the POST. A timeout is an unknown outcome and must be
  // reconciled by name and SHA, not duplicated in a production workspace.
  let uploadResponse
  try {
    uploadResponse = await fetchImpl(canaryUrl(baseUrl, '/v1/assets/upload'), {
      method: 'POST', headers: { ...headers, 'content-type': 'image/png', 'x-asset-name': name, 'x-asset-sha256': digest },
      body: bytes, redirect: 'error', signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw new Error(`CANARY_UPLOAD_OUTCOME_UNKNOWN name=${name} sha256=${digest}; reconcile before another run`)
  }
  const uploaded = await json(uploadResponse)
  const assetId = uploaded?.data?.id
  if (uploadResponse.status !== 201 || uploaded.workspace_id !== workspaceId || typeof assetId !== 'string' || uploaded?.data?.scanStatus !== 'quarantined' || uploaded?.data?.sha256 !== digest) throw new Error(`CANARY_UPLOAD_NOT_QUARANTINED asset=${assetId ?? 'unknown'} sha256=${digest}`)

  const deadline = now() + 120_000
  while (now() < deadline) {
    const readyResponse = await fetchImpl(canaryUrl(baseUrl, '/readyz'), { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000) })
    const ready = await json(readyResponse)
    const scanner = scannerSummary(ready)
    const callbackAt = Date.parse(scanner?.latest_callback_accepted_at ?? '')
    if (readyResponse.ok && Number.isFinite(callbackAt) && callbackAt >= Date.parse(uploadStartedAt)
      && scanner?.ready === true && scanner?.ready_instances >= 1 && scanner?.backlog === 0 && scanner?.dead_letter === 0) {
      const downloaded = await fetchImpl(canaryUrl(baseUrl, `/v1/assets/${encodeURIComponent(assetId)}/download`), { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(10_000) })
      if (downloaded.ok && sha256(Buffer.from(await downloaded.arrayBuffer())) === digest) {
        // The public readiness aggregate is not an asset-bound signed receipt;
        // even a fresh callback could belong to another concurrent upload.
        // The exact downloaded bytes prove this asset became clean, but the
        // protected signer and durable scan-attempt record remain separate gates.
        return { status: 'observed', evidenceType: 'unsigned_observation', releaseId: expectedReleaseId, workspaceId, assetId, sha256: digest, callbackAcceptedAt: new Date(callbackAt).toISOString(), writes: 1, proof: false }
      }
    }
    await sleep(5_000)
  }
  throw new Error(`CANARY_SIGNED_CALLBACK_OR_ASSET_PROOF_MISSING asset=${assetId} sha256=${digest}`)
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  const execute = process.argv.slice(2).includes('--execute')
  runScannerCallbackCanary({ execute }).then(result => {
    console.log(JSON.stringify(result))
  }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
