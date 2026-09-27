import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertOldFormalSignedEvidence, createOldFormalDockerTransport, runOldFormalScannerCanary, scannerEvidenceChildEnv } from './scanner-old-formal-docker-canary.mjs'

const apiId = 'a'.repeat(64)
const workerId = 'b'.repeat(64)
const apiImageId = `sha256:${'c'.repeat(64)}`
const workerImageId = `sha256:${'d'.repeat(64)}`
const networkId = 'e'.repeat(64)
const demoNetworkId = 'f'.repeat(64)
const current = Date.parse('2026-09-27T02:00:00Z')
const env = {
  OLD_SCANNER_API_CONTAINER_ID: apiId,
  OLD_SCANNER_WORKER_CONTAINER_ID: workerId,
  OLD_SCANNER_API_IMAGE_ID: apiImageId,
  OLD_SCANNER_WORKER_IMAGE_ID: workerImageId,
  SCANNER_CANARY_WORKSPACE_ID: 'ws_dedicated',
}
const marker = () => ({
  role: 'scan', hostname: 'scan-container', scopeExplicit: true, state: 'recovery',
  observedAt: new Date(current - 1_000).toISOString(), expiresAt: new Date(current + 14_000).toISOString(),
  instanceId: 'scan-container', ready: false, recoveryCapable: true,
  checks: { databaseReady: true, apiReady: true, redisReady: true },
  clamav: { reachable: true, engineVersion: '1.4.6', definitionsVersion: '28135', definitionsPublishedAt: new Date(current - 3_600_000).toISOString() },
  eicar: { passed: true, signature: 'Eicar-Test-Signature', checkedAt: new Date(current - 30_000).toISOString() },
  callback: { configured: true, capable: false }, queue: { backlog: 0, deadLetter: 0 },
  definitionsMaxAge: 86_400, eicarMaxAge: 900,
})

function fakeDocker({ markerValue = marker(), apiImage = apiImageId, apiNetworks = { 'merchant-production_default': { NetworkID: networkId } }, workerNetworks = { 'merchant-production_default': { NetworkID: networkId } } } = {}) {
  const calls = []
  const docker = (args, input) => {
    calls.push({ args, input })
    if (args[0] === 'inspect') {
      const id = args.at(-1)
      return id === apiId
        ? `${apiId}|${apiImage}|true|/merchant-production-api-replica-1|storenova-api:qa-merchant-ec3d69e3|${JSON.stringify(apiNetworks)}`
        : `${workerId}|${workerImageId}|true|/merchant-production-worker-scan-1|storenova-worker:qa-merchant-ec3d69e3|${JSON.stringify(workerNetworks)}`
    }
    if (args[0] === 'exec' && args[4] === workerId) return JSON.stringify(markerValue)
    if (args[0] === 'exec' && args[4] === apiId) {
      const request = JSON.parse(input)
      return JSON.stringify({ status: request.method === 'POST' ? 201 : 200,
        bodyBase64: Buffer.from(JSON.stringify({ data: { received: request.path } })).toString('base64') })
    }
    throw new Error('unexpected Docker invocation')
  }
  return { docker, calls }
}

test('old formal execute and direct POST fail before Docker for any workspace or self-asserted verification', async () => {
  for (const workspace of ['ws_storenova_fashion', 'ws_arbitrary_new']) {
    const { docker, calls } = fakeDocker()
    const input = { ...env, SCANNER_CANARY_WORKSPACE_ID: workspace,
      SCANNER_CANARY_WORKER_SCOPE_VERIFIED: 'true', SCANNER_CANARY_RECOVERY_VERIFIED: 'true',
      SCANNER_CANARY_ENTITLEMENT_VERIFIED: 'true' }
    await assert.rejects(runOldFormalScannerCanary({ env: input, docker, execute: true, now: () => current }),
      /OLD_SCANNER_DEDICATED_WORKSPACE_PROVENANCE_MISSING/)
    const transport = createOldFormalDockerTransport({ env: input, docker, now: () => current })
    await assert.rejects(transport.fetchImpl(new URL('http://127.0.0.1:8787/v1/assets/upload'), {
      method: 'POST', body: Buffer.from('one-image'),
    }), /OLD_SCANNER_DEDICATED_WORKSPACE_PROVENANCE_MISSING/)
    assert.equal(calls.length, 0)
  }
})

test('exact Docker transport allows only the pinned API demo attachment and routes through container loopback', async () => {
  const { docker, calls } = fakeDocker({ apiNetworks: {
    'merchant-production_default': { NetworkID: networkId },
    'storenova-demo-e0': { NetworkID: demoNetworkId },
  } })
  const transport = createOldFormalDockerTransport({ env: { ...env, OLD_SCANNER_API_SECONDARY_NETWORK_ID: demoNetworkId }, docker, now: () => current })
  assert.equal(await transport.legacyRecoveryProbe(), true)
  const response = await transport.fetchImpl(new URL('http://127.0.0.1:8787/releasez'), {
    method: 'GET', headers: { authorization: 'Bearer secret', 'x-workspace-id': 'ws_dedicated' },
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).data.received, '/releasez')
  assert.equal(calls.filter(call => call.args[0] === 'inspect').length, 4)
  assert.equal(calls.filter(call => call.args[0] === 'exec' && call.args[4] === workerId).length, 1)
  assert.equal(calls.filter(call => call.args[0] === 'exec' && call.args[4] === apiId).length, 1)
  assert.equal(calls.filter(call => call.args[0] === 'exec' && call.args[4] === apiId)
    .every(call => JSON.parse(call.input).path === '/releasez'), true)
  assert.equal(calls.some(call => call.args.join(' ').includes('secret')), false)
  assert.equal(calls.some(call => call.input?.includes('Bearer secret')), true)
})

test('container image drift, network drift, and stale worker marker block before API request', async () => {
  for (const setup of [
    { apiImage: `sha256:${'f'.repeat(64)}` },
    { workerNetworks: { 'merchant-production_default': { NetworkID: 'f'.repeat(64) } } },
    { apiNetworks: { 'storenova-demo-e0': { NetworkID: demoNetworkId } } },
    { apiNetworks: { 'merchant-production_default': { NetworkID: demoNetworkId }, 'storenova-demo-e0': { NetworkID: networkId } } },
    { apiNetworks: { 'merchant-production_default': { NetworkID: networkId }, 'unexpected-egress': { NetworkID: 'f'.repeat(64) } } },
    { workerNetworks: { 'storenova-demo-e0': { NetworkID: demoNetworkId } } },
    { workerNetworks: { 'merchant-production_default': { NetworkID: networkId }, 'unexpected-egress': { NetworkID: 'f'.repeat(64) } } },
    { markerValue: { ...marker(), observedAt: new Date(current - 20_000).toISOString() } },
    { markerValue: { ...marker(), scopeExplicit: false } },
    { markerValue: { ...marker(), callback: { configured: false, capable: false } } },
  ]) {
    const { docker, calls } = fakeDocker(setup)
    const transport = createOldFormalDockerTransport({ env, docker, now: () => current })
    await assert.rejects(transport.legacyRecoveryProbe())
    assert.equal(calls.some(call => call.args[0] === 'exec' && call.args[4] === apiId), false)
  }
})

test('secondary API network requires an exact protected NetworkID binding', async () => {
  const apiNetworks = {
    'merchant-production_default': { NetworkID: networkId },
    'storenova-demo-e0': { NetworkID: demoNetworkId },
  }
  for (const expectedNetworkId of [undefined, '1'.repeat(64)]) {
    const { docker, calls } = fakeDocker({ apiNetworks })
    const transport = createOldFormalDockerTransport({
      env: { ...env, ...(expectedNetworkId ? { OLD_SCANNER_API_SECONDARY_NETWORK_ID: expectedNetworkId } : {}) },
      docker, now: () => current,
    })
    await assert.rejects(transport.legacyRecoveryProbe(), /OLD_SCANNER_NETWORK_MISMATCH/)
    assert.equal(calls.some(call => call.args[0] === 'exec'), false)
  }

  const { docker, calls } = fakeDocker({ apiNetworks })
  assert.throws(() => createOldFormalDockerTransport({
    env: { ...env, OLD_SCANNER_API_SECONDARY_NETWORK_ID: 'not-a-network-id' }, docker, now: () => current,
  }), /OLD_SCANNER_IDENTITY_INPUT_INVALID/)
  assert.equal(calls.length, 0)
})

test('route allowlist rejects gateway, remote host, and unrelated writes before Docker', async () => {
  const { docker, calls } = fakeDocker()
  const transport = createOldFormalDockerTransport({ env, docker, now: () => current })
  for (const [url, method] of [
    ['https://yxsona.com/api/v1/assets/upload', 'POST'],
    ['http://127.0.0.1:8787/mcp', 'POST'],
    ['http://127.0.0.1:8787/v1/assets/other/delete', 'POST'],
  ]) await assert.rejects(transport.fetchImpl(new URL(url), { method }))
  assert.equal(calls.length, 0)
})

test('signed evidence must bind the exact uploaded asset, SHA, and fresh accepted callback', () => {
  const observed = { workspaceId: 'ws_dedicated', uploadName: 'scanner-canary-0123456789abcdef.png', assetId: 'ast_1', sha256: 'a'.repeat(64) }
  const proof = { status: 'passed', releaseProof: false, signatureVerified: true, scanStatus: 'clean',
    ...observed, callbackAcceptedAt: new Date(current - 1_000).toISOString() }
  assert.doesNotThrow(() => assertOldFormalSignedEvidence(proof, observed, current - 2_000, current))
  for (const invalid of [
    { ...proof, assetId: 'ast_other' },
    { ...proof, sha256: 'b'.repeat(64) },
    { ...proof, signatureVerified: false },
    { ...proof, callbackAcceptedAt: new Date(current - 3_000).toISOString() },
  ]) assert.throws(() => assertOldFormalSignedEvidence(invalid, observed, current - 2_000, current), /OLD_SCANNER_SIGNED_EVIDENCE_MISSING/)
})

test('read-only evidence child inherits only its required DB and trusted-key configuration, never API canary credentials', () => {
  const child = scannerEvidenceChildEnv({ PATH: '/safe/bin', SCANNER_CANARY_API_TOKEN: 'secret-token',
    SCANNER_CANARY_CONFIRM: 'confirmation-secret', SCANNER_CANARY_DATABASE_URL: 'postgres://merchant_app:secret@db/merchant',
    SCANNER_CANARY_TRUSTED_KEYRING_FILE: '/run/keys/public.json', SCANNER_CANARY_TRUSTED_KEY_ID: 'scanner-key-1',
    PGSSLMODE: 'verify-full', PGSSLKEY: '/run/keys/client.key', OTHER_SECRET: 'do-not-copy' })
  assert.equal(child.SCANNER_CANARY_DATABASE_URL, 'postgres://merchant_app:secret@db/merchant')
  assert.equal(child.SCANNER_CANARY_TRUSTED_KEYRING_FILE, '/run/keys/public.json')
  assert.equal(child.SCANNER_CANARY_TRUSTED_KEY_ID, 'scanner-key-1')
  assert.equal(child.PGSSLKEY, '/run/keys/client.key')
  assert.equal(child.SCANNER_CANARY_API_TOKEN, undefined)
  assert.equal(child.SCANNER_CANARY_CONFIRM, undefined)
  assert.equal(child.OTHER_SECRET, undefined)
})
