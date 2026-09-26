#!/usr/bin/env node
// One recovery upload to the historical formal API, pinned to its full Docker
// ID. No host port, private container IP, gateway alias, or public DNS is used.
import { spawnSync } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runScannerCallbackCanary } from './scanner-callback-canary.mjs'

export const OLD_FORMAL_RELEASE_ID = 'qa-merchant-ec3d69e3'
export const OLD_FORMAL_RELEASE_SHA = 'ec3d69e37809c0d622c8f38057a072245217004f'
const fullId = /^[a-f0-9]{64}$/u
const imageId = /^sha256:[a-f0-9]{64}$/u
const safeWorkspace = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const dockerBinary = '/usr/bin/docker'

function actualDocker(args, input, timeoutMs = 10_000) {
  const result = spawnSync(dockerBinary, ['--host', 'unix:///var/run/docker.sock', ...args], {
    input, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' },
  })
  // Docker or API stderr may include request metadata; never echo it.
  if (result.error || result.status !== 0) throw new Error('OLD_SCANNER_DOCKER_REQUEST_FAILED')
  return result.stdout.trim()
}

const expectedNetworkName = 'merchant-production_default'
const inspectFormat = '{{.Id}}|{{.Image}}|{{.State.Running}}|{{.Name}}|{{.Config.Image}}|{{json .NetworkSettings.Networks}}'
const workerProbe = `
const fs=require('node:fs');let raw='';process.stdin.setEncoding('utf8');
process.stdin.on('data',x=>{raw+=x;if(raw.length>256)process.exit(2)});
process.stdin.on('end',()=>{let workspace;try{workspace=JSON.parse(raw).workspace}catch{process.exit(2)}
const scope=(process.env.WORKER_WORKSPACES||'').split(',').map(x=>x.trim());
const marker=JSON.parse(fs.readFileSync('/tmp/merchant-worker-scan-ready','utf8'));
const h=marker.heartbeat||{};
process.stdout.write(JSON.stringify({role:process.env.WORKER_ROLE,hostname:process.env.HOSTNAME,
scopeExplicit:process.env.WORKER_AUTO_DISCOVER!=='true'&&!scope.includes('auto')&&!scope.includes('*')&&scope.includes(workspace),
state:marker.state,observedAt:h.observedAt,expiresAt:h.expiresAt,instanceId:h.instanceId,
ready:h.ready,recoveryCapable:h.recoveryCapable,checks:h.checks,clamav:h.clamav,eicar:h.eicar,
callback:h.callback,queue:h.queue,failure:h.failure,
definitionsMaxAge:Number(process.env.SCANNER_DEFINITIONS_MAX_AGE_SECONDS||86400),
eicarMaxAge:Number(process.env.SCANNER_EICAR_MAX_AGE_SECONDS||900)}))});`
const insideRequest = `
let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>{raw+=x;if(raw.length>1048576)process.exit(2)});
process.stdin.on('end',async()=>{try{const x=JSON.parse(raw);const body=x.bodyBase64?Buffer.from(x.bodyBase64,'base64'):undefined;
const r=await fetch('http://127.0.0.1:8787'+x.path,{method:x.method,headers:x.headers,body,redirect:'manual',signal:AbortSignal.timeout(Math.min(28000,Math.max(1,x.timeoutMs)))});
const bytes=Buffer.from(await r.arrayBuffer());if(bytes.length>2097152)process.exit(2);
process.stdout.write(JSON.stringify({status:r.status,bodyBase64:bytes.toString('base64')}))}catch{process.exit(2)}});`

function parseJson(raw, code) {
  try { return JSON.parse(raw) } catch { throw new Error(code) }
}

export function assertOldFormalSignedEvidence(proof, observed, startedAt, observedAt) {
  if (proof?.status !== 'passed' || proof.releaseProof !== false || proof.signatureVerified !== true
    || proof.scanStatus !== 'clean' || proof.workspaceId !== observed.workspaceId || proof.assetId !== observed.assetId
    || proof.sha256 !== observed.sha256 || !Number.isFinite(Date.parse(proof.callbackAcceptedAt))
    || Date.parse(proof.callbackAcceptedAt) < startedAt || Date.parse(proof.callbackAcceptedAt) > observedAt) {
    throw new Error(`OLD_SCANNER_SIGNED_EVIDENCE_MISSING name=${observed.uploadName} asset=${observed.assetId} sha256=${observed.sha256}`)
  }
}

export function scannerEvidenceChildEnv(env) {
  const child = {
    PATH: env.PATH ?? '/usr/bin:/bin',
    NODE_OPTIONS: '',
    SCANNER_CANARY_DATABASE_URL: env.SCANNER_CANARY_DATABASE_URL,
    SCANNER_CANARY_TRUSTED_KEYRING_FILE: env.SCANNER_CANARY_TRUSTED_KEYRING_FILE,
    SCANNER_CANARY_TRUSTED_KEY_ID: env.SCANNER_CANARY_TRUSTED_KEY_ID,
  }
  for (const key of ['PGSSLMODE', 'PGSSLROOTCERT', 'PGSSLCERT', 'PGSSLKEY', 'PGCHANNELBINDING']) {
    if (env[key] !== undefined) child[key] = env[key]
  }
  return child
}

/** All checks are repeated before every request, including the single POST. */
export function createOldFormalDockerTransport({ env, docker = actualDocker, now = Date.now }) {
  const apiId = env.OLD_SCANNER_API_CONTAINER_ID
  const workerId = env.OLD_SCANNER_WORKER_CONTAINER_ID
  const apiImageId = env.OLD_SCANNER_API_IMAGE_ID
  const workerImageId = env.OLD_SCANNER_WORKER_IMAGE_ID
  const workspace = env.SCANNER_CANARY_WORKSPACE_ID
  if (!fullId.test(apiId ?? '') || !fullId.test(workerId ?? '') || apiId === workerId
    || !imageId.test(apiImageId ?? '') || !imageId.test(workerImageId ?? '')
    || !safeWorkspace.test(workspace ?? '')) throw new Error('OLD_SCANNER_IDENTITY_INPUT_INVALID')

  const timedDocker = (args, input, deadline) => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('OLD_SCANNER_REQUEST_TIMEOUT')
    return docker(args, input, remaining)
  }
  const inspect = (id, expectedImage, expectedName, expectedTag, deadline) => {
    const parts = timedDocker(['inspect', '--type', 'container', '--format', inspectFormat, id], undefined, deadline).split('|')
    if (parts.length !== 6 || parts[0] !== id || parts[1] !== expectedImage
      || parts[2] !== 'true' || parts[3] !== expectedName || parts[4] !== expectedTag
      ) {
      throw new Error('OLD_SCANNER_CONTAINER_IDENTITY_MISMATCH')
    }
    let networks
    try { networks = JSON.parse(parts[5]) } catch { throw new Error('OLD_SCANNER_NETWORK_MISMATCH') }
    if (!networks || typeof networks !== 'object' || Array.isArray(networks)
      || Object.keys(networks).length !== 1 || Object.keys(networks)[0] !== expectedNetworkName
      || !fullId.test(networks[expectedNetworkName]?.NetworkID ?? '')) {
      throw new Error('OLD_SCANNER_NETWORK_MISMATCH')
    }
    return networks[expectedNetworkName].NetworkID
  }
  const assertContainers = deadline => {
    const apiNetwork = inspect(apiId, apiImageId, '/merchant-production-api-replica-1', `storenova-api:${OLD_FORMAL_RELEASE_ID}`, deadline)
    const workerNetwork = inspect(workerId, workerImageId, '/merchant-production-worker-scan-1', `storenova-worker:${OLD_FORMAL_RELEASE_ID}`, deadline)
    if (apiNetwork !== workerNetwork) throw new Error('OLD_SCANNER_NETWORK_MISMATCH')
  }
  const legacyRecoveryProbe = async (deadline = Date.now() + 10_000) => {
    assertContainers(deadline)
    const raw = timedDocker(['exec', '-i', '-e', 'NODE_OPTIONS=', workerId, 'node', '-e', workerProbe], JSON.stringify({ workspace }), deadline)
    const p = parseJson(raw, 'OLD_SCANNER_WORKER_PROBE_INVALID')
    const observed = Date.parse(p.observedAt)
    const expires = Date.parse(p.expiresAt)
    const current = now()
    const eicarAt = Date.parse(p.eicar?.checkedAt)
    const publishedAt = Date.parse(p.clamav?.definitionsPublishedAt)
    const fresh = Number.isFinite(observed) && observed <= current && current - observed <= 15_000
      && Number.isFinite(expires) && expires > current
      && Number.isFinite(eicarAt) && eicarAt <= current && current - eicarAt <= p.eicarMaxAge * 1000
      && Number.isFinite(publishedAt) && publishedAt <= current && current - publishedAt <= p.definitionsMaxAge * 1000
    if (p.role !== 'scan' || !p.scopeExplicit || p.instanceId !== p.hostname
      || p.state !== 'recovery' || p.ready !== false || p.recoveryCapable !== true
      || !fresh || p.checks?.databaseReady !== true || p.checks?.apiReady !== true || p.checks?.redisReady !== true
      || p.clamav?.reachable !== true || !p.clamav?.engineVersion || !p.clamav?.definitionsVersion
      || p.eicar?.passed !== true || p.eicar?.signature !== 'Eicar-Test-Signature'
      || p.callback?.configured !== true || p.queue?.backlog !== 0 || p.queue?.deadLetter !== 0
      || p.failure || !Number.isSafeInteger(p.eicarMaxAge) || !Number.isSafeInteger(p.definitionsMaxAge)) {
      throw new Error('OLD_SCANNER_RECOVERY_PROOF_BLOCKED')
    }
    return true
  }
  const fetchImpl = async (url, options) => {
    const target = new URL(url)
    if (target.origin !== 'http://127.0.0.1:8787' || target.username || target.password || target.hash) throw new Error('OLD_SCANNER_ROUTE_INVALID')
    const path = target.pathname + target.search
    const method = options?.method
    const allowed = (method === 'GET' && ['/releasez', '/healthz', '/readyz', '/v1/assets?limit=1'].includes(path))
      || (method === 'GET' && /^\/v1\/assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/download$/u.test(path))
      || (method === 'POST' && path === '/v1/assets/upload')
    if (!allowed) throw new Error('OLD_SCANNER_ROUTE_INVALID')
    // spawnSync cannot observe the caller's AbortSignal while blocked. Share
    // one hard deadline across identity checks, worker proof and the request.
    const deadline = Date.now() + (method === 'POST' ? 30_000 : 10_000)
    assertContainers(deadline)
    // The worker marker is checked at the last possible point before POST.
    if (method === 'POST') await legacyRecoveryProbe(deadline)
    const wire = parseJson(timedDocker(['exec', '-i', '-e', 'NODE_OPTIONS=', apiId, 'node', '-e', insideRequest], JSON.stringify({
      path, method, headers: options.headers ?? {},
      ...(options.body ? { bodyBase64: Buffer.from(options.body).toString('base64') } : {}),
      timeoutMs: Math.max(1, deadline - Date.now()),
    }), deadline), 'OLD_SCANNER_API_RESPONSE_INVALID')
    if (!Number.isInteger(wire.status) || wire.status < 200 || wire.status > 599
      || wire.status >= 300 && wire.status < 400 || typeof wire.bodyBase64 !== 'string') throw new Error('OLD_SCANNER_API_RESPONSE_INVALID')
    return new Response(Buffer.from(wire.bodyBase64, 'base64'), { status: wire.status })
  }
  return { fetchImpl, legacyRecoveryProbe }
}

export async function runOldFormalScannerCanary({ env = process.env, docker = actualDocker, execute = false, now = Date.now, sleep } = {}) {
  const exactEnv = { ...env, SCANNER_CANARY_API_BASE_URL: 'http://127.0.0.1:8787',
    SCANNER_CANARY_EXPECTED_API_ORIGIN: 'http://127.0.0.1:8787',
    SCANNER_CANARY_RELEASE_ID: OLD_FORMAL_RELEASE_ID, SCANNER_CANARY_RELEASE_GIT_SHA: OLD_FORMAL_RELEASE_SHA }
  if (execute && (!exactEnv.SCANNER_CANARY_DATABASE_URL || !isAbsolute(exactEnv.SCANNER_CANARY_TRUSTED_KEYRING_FILE ?? '')
    || !safeWorkspace.test(exactEnv.SCANNER_CANARY_TRUSTED_KEY_ID ?? ''))) throw new Error('OLD_SCANNER_SIGNED_EVIDENCE_INPUT_MISSING')
  const transport = createOldFormalDockerTransport({ env: exactEnv, docker, now })
  const startedAt = now()
  const observed = await runScannerCallbackCanary({ env: exactEnv, execute, ...transport, now, ...(sleep ? { sleep } : {}) })
  if (!execute) return observed
  const proofProcess = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./scanner-callback-canary-evidence.ts', import.meta.url)),
    '--workspace-id', observed.workspaceId, '--asset-id', observed.assetId, '--sha256', observed.sha256,
    '--trusted-key-id', exactEnv.SCANNER_CANARY_TRUSTED_KEY_ID], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 128 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    env: scannerEvidenceChildEnv(exactEnv),
  })
  let proof = null
  if (proofProcess.status === 0) {
    try { proof = parseJson(proofProcess.stdout, 'OLD_SCANNER_SIGNED_EVIDENCE_INVALID') } catch { /* Include the asset binding in the error below. */ }
  }
  assertOldFormalSignedEvidence(proof, observed, startedAt, now())
  return { ...observed, signedAssetBinding: true, signedEvidence: {
    eventId: proof.eventId, receiptId: proof.receiptId, keyId: proof.keyId, callbackAcceptedAt: proof.callbackAcceptedAt,
  } }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runOldFormalScannerCanary({ execute: process.argv.slice(2).includes('--execute') }).then(value => {
    process.stdout.write(`${JSON.stringify(value)}\n`)
  }).catch(error => {
    // A failed upload may have an unknown outcome. Preserve the standard
    // canary's specific reconciliation error without exposing credentials.
    const safe = error instanceof Error && (/^OLD_SCANNER_SIGNED_EVIDENCE_MISSING asset=[A-Za-z0-9._-]+ sha256=[a-f0-9]{64}$/u.test(error.message)
      || /^OLD_SCANNER_SIGNED_EVIDENCE_MISSING name=scanner-canary-[a-f0-9]+\.png asset=[A-Za-z0-9._-]+ sha256=[a-f0-9]{64}$/u.test(error.message)
      || /^CANARY_UPLOAD_OUTCOME_UNKNOWN name=scanner-canary-[a-f0-9]+\.png sha256=[a-f0-9]{64} asset=unknown; reconcile before another run$/u.test(error.message)
      || /^CANARY_POST_UPLOAD_FAILED name=scanner-canary-[a-f0-9]+\.png sha256=[a-f0-9]{64} asset=(?:[A-Za-z0-9._-]{1,128}|unknown) reason=(?:response_invalid|upload_not_quarantined|callback_or_asset_proof_missing|post_processing_failed)$/u.test(error.message))
      ? error.message : 'OLD_FORMAL_SCANNER_CANARY_BLOCKED; inspect exact-container and asset evidence before retry'
    process.stderr.write(`${safe}\n`)
    process.exitCode = 1
  })
}
