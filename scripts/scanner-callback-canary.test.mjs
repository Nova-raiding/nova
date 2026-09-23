import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { canaryAdmission, canaryPng, runScannerCallbackCanary } from './scanner-callback-canary.mjs'

const sha = 'a'.repeat(40)
const env = {
  SCANNER_CANARY_API_BASE_URL: 'https://candidate.example/api',
  SCANNER_CANARY_RELEASE_ID: 'release-20260923-test',
  SCANNER_CANARY_RELEASE_GIT_SHA: sha,
  SCANNER_CANARY_WORKSPACE_ID: 'ws_canary',
  SCANNER_CANARY_CONFIRM: 'release-20260923-test:ws_canary',
  SCANNER_CANARY_WORKER_SCOPE_VERIFIED: 'true',
  SCANNER_CANARY_ENTITLEMENT_VERIFIED: 'true',
  SCANNER_CANARY_API_TOKEN: 'not-a-real-token',
}
const envelope = (data, workspace_id = 'system') => ({ data, workspace_id, error: null })
const response = (data, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => data, arrayBuffer: async () => data })
const release = response(envelope({ release: { release_id: env.SCANNER_CANARY_RELEASE_ID, release_git_sha: sha }, ready: true }))

test('PNG has valid signature and unique signed bytes', () => {
  const one = canaryPng(Buffer.from([1, 2, 3]))
  const two = canaryPng(Buffer.from([1, 2, 4]))
  assert.equal(one.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.notEqual(createHash('sha256').update(one).digest('hex'), createHash('sha256').update(two).digest('hex'))
})

test('dry run is read-only and checks exact release', async () => {
  const methods = []
  const result = await runScannerCallbackCanary({ env, fetchImpl: async (url, options) => { methods.push([url.pathname, options.method]); return release } })
  assert.deepEqual(methods, [['/api/releasez', 'GET']])
  assert.deepEqual(result, { status: 'dry_run', evidenceType: 'unsigned_observation', releaseId: env.SCANNER_CANARY_RELEASE_ID, workspaceId: 'ws_canary', writes: 0, proof: false })
})

test('execution requires workspace, entitlement and release-bound confirmation before HTTP', () => {
  for (const field of ['SCANNER_CANARY_CONFIRM', 'SCANNER_CANARY_WORKER_SCOPE_VERIFIED', 'SCANNER_CANARY_ENTITLEMENT_VERIFIED', 'SCANNER_CANARY_API_TOKEN']) {
    assert.throws(() => canaryAdmission({ ...env, [field]: '' }, true))
  }
  assert.throws(() => canaryAdmission({ ...env, SCANNER_CANARY_API_BASE_URL: 'http://remote.example/api' }, false), /HTTPS/)
})

test('release mismatch aborts before upload', async () => {
  const methods = []
  await assert.rejects(runScannerCallbackCanary({ env, execute: true, fetchImpl: async (url, options) => { methods.push(options.method); return response(envelope({ release: { release_id: 'wrong', release_git_sha: sha }, ready: true })) } }), /IDENTITY_MISMATCH/)
  assert.deepEqual(methods, ['GET'])
})

test('one quarantined upload requires fresh callback and exact clean download', async () => {
  const calls = []
  let uploadBytes
  let time = Date.parse('2026-09-23T10:00:00Z')
  const fetchImpl = async (url, options) => {
    calls.push([url.pathname, url.search, options.method])
    if (url.pathname === '/api/releasez') return release
    if (url.pathname === '/api/v1/assets' && options.method === 'GET') return response(envelope({ items: [], storage_quota: { availableBytes: 100_000 } }, 'ws_canary'))
    if (url.pathname === '/api/v1/assets/upload') {
      uploadBytes = Buffer.from(options.body)
      assert.equal(options.headers['x-asset-sha256'], createHash('sha256').update(uploadBytes).digest('hex'))
      return response(envelope({ id: 'ast_canary', scanStatus: 'quarantined', sha256: options.headers['x-asset-sha256'] }, 'ws_canary'), 201)
    }
    if (url.pathname === '/api/readyz') return response(envelope({ scanner: { ready: true, ready_instances: 1, backlog: 0, dead_letter: 0, latest_callback_accepted_at: '2026-09-23T10:00:01Z' } }))
    if (url.pathname === '/api/v1/assets/ast_canary/download') return response(uploadBytes.buffer.slice(uploadBytes.byteOffset, uploadBytes.byteOffset + uploadBytes.byteLength))
    throw new Error(`unexpected ${url.pathname}`)
  }
  const result = await runScannerCallbackCanary({ env, execute: true, fetchImpl, now: () => time, sleep: async ms => { time += ms }, nonce: Buffer.from([1, 2, 3]) })
  assert.equal(result.status, 'observed')
  assert.equal(result.evidenceType, 'unsigned_observation')
  assert.equal(result.writes, 1)
  assert.equal(result.proof, false)
  assert.equal(calls.filter(call => call[2] === 'POST').length, 1)
  assert.deepEqual(calls[1], ['/api/v1/assets', '?limit=1', 'GET'])
})

test('old callback never counts as this run even when /readyz is green', async () => {
  let time = Date.parse('2026-09-23T10:00:00Z')
  const fetchImpl = async (url, options) => {
    if (url.pathname === '/api/releasez') return release
    if (url.pathname === '/api/v1/assets' && options.method === 'GET') return response(envelope({ items: [], storage_quota: { availableBytes: 100_000 } }, 'ws_canary'))
    if (url.pathname === '/api/v1/assets/upload') return response(envelope({ id: 'ast_canary', scanStatus: 'quarantined', sha256: options.headers['x-asset-sha256'] }, 'ws_canary'), 201)
    if (url.pathname === '/api/readyz') return response(envelope({ scanner: { ready: true, ready_instances: 1, backlog: 0, dead_letter: 0, latest_callback_accepted_at: '2026-09-23T09:59:59Z' } }))
    throw new Error(`unexpected ${url.pathname}`)
  }
  await assert.rejects(runScannerCallbackCanary({ env, execute: true, fetchImpl, now: () => time, sleep: async ms => { time += ms } }), /CALLBACK_OR_ASSET_PROOF_MISSING/)
})

test('upload timeout is unknown outcome and is never retried', async () => {
  let posts = 0
  const fetchImpl = async (url, options) => {
    if (url.pathname === '/api/releasez') return release
    if (url.pathname === '/api/v1/assets' && options.method === 'GET') return response(envelope({ items: [], storage_quota: { availableBytes: 100_000 } }, 'ws_canary'))
    if (url.pathname === '/api/v1/assets/upload') { posts++; throw new Error('connection reset') }
    throw new Error(`unexpected ${url.pathname}`)
  }
  await assert.rejects(runScannerCallbackCanary({ env, execute: true, fetchImpl }), /CANARY_UPLOAD_OUTCOME_UNKNOWN name=scanner-canary-[a-f0-9]+\.png sha256=[a-f0-9]{64}/u)
  assert.equal(posts, 1)
})
