import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { after, before, test } from 'node:test'
import { copyRelease, loopbackRegistry } from '../infra/scripts/copy-oci-release-loopback.mjs'

const artifacts = ['merchant-api', 'merchant-worker', 'merchant-ui', 'merchant-ops-ui', 'payment-gateway', 'pilot-gateway']
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const json = value => Buffer.from(JSON.stringify(value))
const media = { index: 'application/vnd.oci.image.index.v1+json', manifest: 'application/vnd.oci.image.manifest.v1+json' }
const containers = []
let source, target

async function request(url, options, expected) {
  const response = await fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(20_000) })
  assert.equal(response.status, expected, `${options?.method ?? 'GET'} ${url}: ${response.status}`)
  return response
}

function docker(...args) { return execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 }).trim() }
async function startRegistry(name) {
  const id = docker('run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::5000', 'registry:2')
  containers.push(id)
  const address = docker('port', id, '5000/tcp')
  const match = /^127\.0\.0\.1:(\d+)$/u.exec(address)
  assert.ok(match, 'registry must bind only IPv4 loopback')
  const base = `http://127.0.0.1:${match[1]}`
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await fetch(`${base}/v2/`, { signal: AbortSignal.timeout(1000) })).status === 200) return base }
    catch { /* startup */ }
    await new Promise(done => setTimeout(done, 100))
  }
  throw new Error('isolated registry did not become ready')
}

async function blob(base, repo, bytes) {
  const name = digest(bytes)
  const begin = await request(`${base}/v2/${repo}/blobs/uploads/`, { method: 'POST', headers: { 'content-length': '0' } }, 202)
  const upload = new URL(begin.headers.get('location'), base)
  upload.searchParams.set('digest', name)
  const done = await request(upload, { method: 'PUT', body: bytes,
    headers: { 'content-length': String(bytes.length), 'content-type': 'application/octet-stream' } }, 201)
  assert.equal(done.headers.get('docker-content-digest'), name)
  return { digest: name, size: bytes.length }
}

async function manifest(base, repo, bytes, reference) {
  const result = await request(`${base}/v2/${repo}/manifests/${reference}`, { method: 'PUT', body: bytes,
    headers: { 'content-type': JSON.parse(bytes).mediaType, 'content-length': String(bytes.length) } }, 201)
  assert.equal(result.headers.get('docker-content-digest'), digest(bytes))
  return { digest: digest(bytes), size: bytes.length }
}

async function fixture({ releaseId, arch = 'amd64' }) {
  const gitSha = 'a'.repeat(40), sourceSha = `sha256:${'b'.repeat(64)}`
  const references = {}, digests = {}
  for (const artifact of artifacts) {
    const repo = `storenova/${artifact}`
    const configuration = json({ architecture: arch, os: 'linux', config: { Labels: {
      'org.opencontainers.image.revision': gitSha,
      'com.storenova.release.id': releaseId,
      'com.storenova.release.source_sha256': sourceSha,
    } } })
    const config = await blob(source, repo, configuration)
    const layer = await blob(source, repo, Buffer.from(`layer-${artifact}`))
    const runtimeBytes = json({ schemaVersion: 2, mediaType: media.manifest,
      config: { mediaType: 'application/vnd.oci.image.config.v1+json', ...config },
      layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', ...layer }] })
    const runtime = await manifest(source, repo, runtimeBytes, digest(runtimeBytes))
    const attestationConfig = await blob(source, repo, Buffer.from('{}'))
    const attestationLayer = await blob(source, repo, Buffer.from(`attestation-${artifact}`))
    const attestationBytes = json({ schemaVersion: 2, mediaType: media.manifest,
      config: { mediaType: 'application/vnd.oci.empty.v1+json', ...attestationConfig },
      layers: [{ mediaType: 'application/vnd.in-toto+json', ...attestationLayer }] })
    const attestation = await manifest(source, repo, attestationBytes, digest(attestationBytes))
    const rootBytes = json({ schemaVersion: 2, mediaType: media.index, manifests: [
      { mediaType: media.manifest, ...runtime, platform: { os: 'linux', architecture: arch } },
      { mediaType: media.manifest, ...attestation, platform: { os: 'unknown', architecture: 'unknown' },
        annotations: { 'vnd.docker.reference.type': 'attestation-manifest' } },
    ] })
    const root = await manifest(source, repo, rootBytes, releaseId)
    references[artifact] = `${new URL(source).host}/${repo}@${root.digest}`
    digests[artifact] = root.digest
  }
  return { schema_version: 1, release_id: releaseId, release_git_sha: gitSha, source_sha256: sourceSha,
    image_references: references, image_digests: digests }
}

before(async () => {
  docker('image', 'inspect', 'registry:2')
  const nonce = randomBytes(5).toString('hex')
  source = await startRegistry(`oci-copy-source-${nonce}`)
  target = await startRegistry(`oci-copy-target-${nonce}`)
})
after(() => { for (const id of containers.reverse()) { try { docker('stop', id) } catch { /* exact owned container only */ } } })

test('endpoints reject public names, redirects and ambiguous loopback aliases', () => {
  for (const url of ['http://localhost:5002', 'http://127.0.0.2:5002', 'https://127.0.0.1:5002',
    'http://127.0.0.1:5002/path', 'http://127.0.0.1:5002/?x=1', 'http://user@127.0.0.1:5002']) {
    assert.throws(() => loopbackRegistry(url, 'SOURCE'), /MUST_BE_EXPLICIT_IPV4_LOOPBACK/u)
  }
})

test('copies six OCI indexes, runtime and attestation manifests, and every blob without digest changes', async () => {
  const release = await fixture({ releaseId: `release-copy-${randomBytes(4).toString('hex')}` })
  const report = await copyRelease({ releaseImages: release, sourceRegistry: source, targetRegistry: target,
    targetReferenceHost: '127.0.0.1:5000', expectedGitSha: release.release_git_sha,
    expectedSourceSha256: release.source_sha256 })
  assert.equal(report.status, 'copied_and_verified')
  assert.equal(report.production_authorized, false)
  assert.equal(report.images.length, 6)
  for (const record of report.images) {
    assert.equal(record.manifests_verified, 3)
    assert.equal(record.blobs_verified, 4)
    assert.equal(record.runtime_configs_verified, 1)
    const tag = await request(`${target}/v2/${record.repository}/manifests/${release.release_id}`,
      { headers: { accept: media.index } }, 200)
    assert.equal(tag.headers.get('docker-content-digest'), record.digest)
    assert.equal(digest(Buffer.from(await tag.arrayBuffer())), record.digest)
    assert.equal(record.target_reference, `127.0.0.1:5000/${record.repository}@${record.digest}`)
  }
  await assert.rejects(copyRelease({ releaseImages: release, sourceRegistry: source, targetRegistry: target,
    targetReferenceHost: '127.0.0.1:5000', expectedGitSha: release.release_git_sha,
    expectedSourceSha256: release.source_sha256 }), /TARGET_TAG_ALREADY_EXISTS/u)
})

test('rejects source identity and non-amd64 runtime before publishing a tag', async () => {
  const release = await fixture({ releaseId: `release-arm-${randomBytes(4).toString('hex')}`, arch: 'arm64' })
  await assert.rejects(copyRelease({ releaseImages: release, sourceRegistry: source, targetRegistry: target,
    targetReferenceHost: '127.0.0.1:5000', expectedGitSha: 'c'.repeat(40),
    expectedSourceSha256: release.source_sha256 }), /SIX_IMAGE_IDENTITY_INVALID/u)
  await assert.rejects(copyRelease({ releaseImages: release, sourceRegistry: source, targetRegistry: target,
    targetReferenceHost: '127.0.0.1:5000', expectedGitSha: release.release_git_sha,
    expectedSourceSha256: release.source_sha256 }), /INDEX_PLATFORM_UNREVIEWED/u)
  const absent = await request(`${target}/v2/storenova/merchant-api/manifests/${release.release_id}`,
    { method: 'HEAD', headers: { accept: media.index } }, 404)
  assert.equal(absent.status, 404)
})

test('rejects a source repository prefix outside the reviewed storenova path', async () => {
  const release = await fixture({ releaseId: `release-prefix-${randomBytes(4).toString('hex')}` })
  release.image_references['merchant-api'] = release.image_references['merchant-api'].replace('/storenova/merchant-api@', '/other/merchant-api@')
  await assert.rejects(copyRelease({ releaseImages: release, sourceRegistry: source, targetRegistry: target,
    targetReferenceHost: '127.0.0.1:5000', expectedGitSha: release.release_git_sha,
    expectedSourceSha256: release.source_sha256 }), /REPOSITORY_merchant-api_INVALID/u)
})

test('rejects a forged digest header and refuses registry redirects', async () => {
  const release = await fixture({ releaseId: `release-forged-${randomBytes(4).toString('hex')}` })
  let responseMode = 'forged'
  const server = createServer((req, res) => {
    if (responseMode === 'redirect') {
      res.writeHead(307, { location: 'https://example.com/unreviewed-registry' }); res.end(); return
    }
    const bytes = Buffer.from('{}')
    res.writeHead(200, { 'content-type': media.index, 'content-length': String(bytes.length),
      'docker-content-digest': release.image_digests['merchant-api'] })
    res.end(bytes)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const fake = `http://127.0.0.1:${address.port}`
  for (const artifact of artifacts) release.image_references[artifact] =
    release.image_references[artifact].replace(new URL(source).host, new URL(fake).host)
  const input = { releaseImages: release, sourceRegistry: fake, targetRegistry: target,
    targetReferenceHost: '127.0.0.1:5000', expectedGitSha: release.release_git_sha,
    expectedSourceSha256: release.source_sha256 }
  try {
    await assert.rejects(copyRelease(input), /SOURCE_MANIFEST_BYTES_INVALID/u)
    responseMode = 'redirect'
    await assert.rejects(copyRelease(input), /SOURCE_MANIFEST_HTTP_307/u)
  } finally { server.close(); await once(server, 'close') }
  await request(`${target}/v2/storenova/merchant-api/manifests/${release.release_id}`,
    { method: 'HEAD', headers: { accept: media.index } }, 404)
})
