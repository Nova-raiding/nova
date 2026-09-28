#!/usr/bin/env node
// Copy an immutable six-image release between two loopback OCI registries.
// The destination URL is a transport endpoint (normally an explicit SSH
// tunnel); this tool never opens SSH, Docker, a public listener, or a database.
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'

const ARTIFACTS = Object.freeze(['merchant-api', 'merchant-worker', 'merchant-ui', 'merchant-ops-ui', 'payment-gateway', 'pilot-gateway'])
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const SHA = /^[0-9a-f]{40}$/u
const REPO = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u
const INDEX_TYPES = new Set(['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'])
const MANIFEST_TYPES = new Set(['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'])
const ACCEPT = [...INDEX_TYPES, ...MANIFEST_TYPES].join(', ')
const MAX_MANIFEST = 4 * 1024 * 1024
const MAX_BLOB = 4 * 1024 * 1024 * 1024
const fail = message => { throw new Error(`OCI_RELEASE_COPY_${message}`) }
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const assert = (condition, message) => { if (!condition) fail(message) }
const sameKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')

export function loopbackRegistry(value, label) {
  let url
  try { url = new URL(value) } catch { fail(`${label}_URL_INVALID`) }
  assert(url.protocol === 'http:' && url.hostname === '127.0.0.1' && /^\d+$/u.test(url.port)
    && Number(url.port) > 0 && Number(url.port) <= 65535 && url.pathname === '/'
    && !url.username && !url.password && !url.search && !url.hash, `${label}_MUST_BE_EXPLICIT_IPV4_LOOPBACK`)
  return url
}

function checkInput(input) {
  const { releaseImages, sourceRegistry, targetRegistry, targetReferenceHost, expectedGitSha, expectedSourceSha256 } = input
  const source = loopbackRegistry(sourceRegistry, 'SOURCE')
  const target = loopbackRegistry(targetRegistry, 'TARGET')
  assert(source.origin !== target.origin, 'SOURCE_AND_TARGET_MUST_DIFFER')
  assert(targetReferenceHost === '127.0.0.1:5000', 'TARGET_REFERENCE_HOST_MUST_BE_101_LOOPBACK')
  assert(SHA.test(expectedGitSha ?? '') && DIGEST.test(expectedSourceSha256 ?? ''), 'EXPECTED_SOURCE_IDENTITY_INVALID')
  assert(releaseImages?.schema_version === 1 && /^release-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(releaseImages.release_id ?? '')
    && releaseImages.release_git_sha === expectedGitSha && releaseImages.source_sha256 === expectedSourceSha256
    && sameKeys(releaseImages.image_digests, ARTIFACTS) && sameKeys(releaseImages.image_references, ARTIFACTS),
  'SIX_IMAGE_IDENTITY_INVALID')
  const images = ARTIFACTS.map(artifact => {
    const reference = releaseImages.image_references[artifact]
    const match = /^([^@]+)@(sha256:[0-9a-f]{64})$/u.exec(reference ?? '')
    assert(match && match[2] === releaseImages.image_digests[artifact], `REFERENCE_${artifact}_INVALID`)
    const slash = match[1].indexOf('/')
    const registry = match[1].slice(0, slash)
    const repo = match[1].slice(slash + 1)
    assert(registry === source.host && REPO.test(repo) && repo === `storenova/${artifact}`, `REPOSITORY_${artifact}_INVALID`)
    return { artifact, repo, digest: match[2], targetReference: `${targetReferenceHost}/${repo}@${match[2]}` }
  })
  assert(new Set(images.map(item => item.repo)).size === ARTIFACTS.length, 'REPOSITORIES_NOT_DISTINCT')
  return { source, target, images }
}

function apiUrl(base, repo, kind, reference) {
  const path = `/v2/${repo.split('/').map(encodeURIComponent).join('/')}/${kind}/${encodeURIComponent(reference)}`
  return new URL(path, base)
}

async function request(url, options, expected, label) {
  const response = await fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(120_000) })
  assert(expected.includes(response.status), `${label}_HTTP_${response.status}`)
  return response
}

function digestHeader(response, expected, label) {
  const value = response.headers.get('docker-content-digest')
  assert(value === expected, `${label}_DIGEST_HEADER_MISMATCH`)
}

async function readManifest(base, repo, reference, expectedDigest, expectedSize, label) {
  const response = await request(apiUrl(base, repo, 'manifests', reference), { headers: { accept: ACCEPT } }, [200], label)
  const declared = Number(response.headers.get('content-length'))
  assert(Number.isSafeInteger(declared) && declared > 0 && declared <= MAX_MANIFEST &&
    (expectedSize === undefined || declared === expectedSize), `${label}_SIZE_INVALID`)
  digestHeader(response, expectedDigest, label)
  assert(response.body, `${label}_BODY_MISSING`)
  const chunks = []
  let size = 0
  for await (const chunk of Readable.fromWeb(response.body)) {
    size += chunk.length
    assert(size <= declared && size <= MAX_MANIFEST, `${label}_BODY_OVERSIZE`)
    chunks.push(chunk)
  }
  const bytes = Buffer.concat(chunks, size)
  assert(bytes.length === declared && hash(bytes) === expectedDigest, `${label}_BYTES_INVALID`)
  const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim()
  assert(INDEX_TYPES.has(mediaType) || MANIFEST_TYPES.has(mediaType), `${label}_MEDIA_TYPE_INVALID`)
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { fail(`${label}_JSON_INVALID`) }
  assert(value?.schemaVersion === 2 && value.mediaType === mediaType, `${label}_SCHEMA_INVALID`)
  return { bytes, value, mediaType }
}

function descriptor(value, label) {
  assert(value && typeof value === 'object' && DIGEST.test(value.digest ?? '') &&
    Number.isSafeInteger(value.size) && value.size >= 0 && value.size <= MAX_BLOB &&
    typeof value.mediaType === 'string' && value.mediaType.length < 256, `${label}_DESCRIPTOR_INVALID`)
  return value
}

async function downloadBlob(base, repo, item, temporary, label) {
  const response = await request(apiUrl(base, repo, 'blobs', item.digest), {}, [200], label)
  digestHeader(response, item.digest, label)
  const declared = Number(response.headers.get('content-length'))
  assert(declared === item.size && item.size <= MAX_BLOB && response.body, `${label}_SIZE_INVALID`)
  const checksum = createHash('sha256')
  let bytes = 0
  const meter = new Transform({ transform(chunk, _, done) {
    bytes += chunk.length
    if (bytes > item.size) { done(new Error(`${label}_OVERSIZE`)); return }
    checksum.update(chunk); done(null, chunk)
  } })
  await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))
  assert(bytes === item.size && `sha256:${checksum.digest('hex')}` === item.digest, `${label}_BYTES_INVALID`)
}

async function uploadBlob(base, repo, item, temporary) {
  const begin = await request(new URL(`/v2/${repo}/blobs/uploads/`, base), { method: 'POST', headers: { 'content-length': '0' } }, [202], 'BLOB_UPLOAD_START')
  const location = begin.headers.get('location')
  assert(location, 'BLOB_UPLOAD_LOCATION_MISSING')
  const upload = new URL(location, base)
  assert(upload.origin === base.origin && upload.pathname.startsWith(`/v2/${repo}/blobs/uploads/`), 'BLOB_UPLOAD_LOCATION_UNSAFE')
  assert(!upload.searchParams.has('digest'), 'BLOB_UPLOAD_LOCATION_DIGEST_AMBIGUOUS')
  upload.searchParams.set('digest', item.digest)
  const complete = await request(upload, { method: 'PUT', body: createReadStream(temporary), duplex: 'half',
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(item.size) } }, [201], 'BLOB_UPLOAD')
  digestHeader(complete, item.digest, 'BLOB_UPLOAD')
}

async function putManifest(base, repo, reference, manifest, expectedDigest) {
  const response = await request(apiUrl(base, repo, 'manifests', reference), { method: 'PUT',
    headers: { 'content-type': manifest.mediaType, 'content-length': String(manifest.bytes.length) },
    body: manifest.bytes }, [201, 202], 'MANIFEST_PUT')
  digestHeader(response, expectedDigest, 'MANIFEST_PUT')
  const received = await readManifest(base, repo, reference, expectedDigest, manifest.bytes.length, 'TARGET_MANIFEST')
  assert(received.bytes.equals(manifest.bytes), 'TARGET_MANIFEST_BYTES_DIFFER')
}

function validateConfig(bytes, identity, artifact) {
  let config
  try { config = JSON.parse(bytes.toString('utf8')) } catch { fail(`${artifact}_CONFIG_JSON_INVALID`) }
  const labels = config?.config?.Labels
  assert(config?.os === 'linux' && config?.architecture === 'amd64' &&
    labels?.['org.opencontainers.image.revision'] === identity.release_git_sha &&
    labels?.['com.storenova.release.id'] === identity.release_id &&
    labels?.['com.storenova.release.source_sha256'] === identity.source_sha256,
  `${artifact}_RUNTIME_CONFIG_IDENTITY_INVALID`)
}

export async function copyRelease(input) {
  const { source, target, images } = checkInput(input)
  const identity = input.releaseImages
  const work = await mkdtemp(join(tmpdir(), 'oci-release-copy-'))
  const records = []
  try {
    for (const image of images) {
      const tag = apiUrl(target, image.repo, 'manifests', identity.release_id)
      const existing = await request(tag, { method: 'HEAD', headers: { accept: ACCEPT } }, [200, 404], 'TARGET_TAG_PREFLIGHT')
      assert(existing.status === 404, `${image.artifact}_TARGET_TAG_ALREADY_EXISTS`)
    }
    for (const image of images) {
      const seenManifests = new Set(), seenBlobs = new Set()
      let runtimeConfigs = 0, blobBytes = 0
      const copyBlob = async (raw, label) => {
        const item = descriptor(raw, label)
        if (label === 'CONFIG_RUNTIME') assert(item.size > 0 && item.size <= 8 * 1024 * 1024, 'RUNTIME_CONFIG_SIZE_INVALID')
        if (seenBlobs.has(item.digest)) return
        seenBlobs.add(item.digest)
        const temporary = join(work, item.digest.slice(7))
        try {
          await downloadBlob(source, image.repo, item, temporary, `SOURCE_${label}`)
          const exists = await request(apiUrl(target, image.repo, 'blobs', item.digest), { method: 'HEAD' }, [200, 404], 'TARGET_BLOB_PREFLIGHT')
          if (exists.status === 404) await uploadBlob(target, image.repo, item, temporary)
          const confirmed = join(work, `${item.digest.slice(7)}.target`)
          try { await downloadBlob(target, image.repo, item, confirmed, `TARGET_${label}`) }
          finally { await rm(confirmed, { force: true }) }
          blobBytes += item.size
          if (label === 'CONFIG_RUNTIME') { validateConfig(readFileSync(temporary), identity, image.artifact); runtimeConfigs++ }
        } finally { await rm(temporary, { force: true }) }
      }
      const copyManifest = async (digest, mediaType, size, runtime, depth) => {
        assert(depth <= 3 && !seenManifests.has(digest), 'MANIFEST_CYCLE_OR_DEPTH_INVALID')
        seenManifests.add(digest)
        const manifest = await readManifest(source, image.repo, digest, digest, size, 'SOURCE_MANIFEST')
        assert(!mediaType || manifest.mediaType === mediaType, 'MANIFEST_DESCRIPTOR_MEDIA_TYPE_MISMATCH')
        if (INDEX_TYPES.has(manifest.mediaType)) {
          assert(Array.isArray(manifest.value.manifests) && manifest.value.manifests.length > 0 && manifest.value.manifests.length <= 16,
            'INDEX_CHILDREN_INVALID')
          for (const child of manifest.value.manifests) {
            descriptor(child, 'INDEX_CHILD')
            const platform = child.platform
            const executable = platform?.os === 'linux' && platform?.architecture === 'amd64'
            const attestation = platform?.os === 'unknown' && platform?.architecture === 'unknown' &&
              child.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest'
            assert(executable || attestation, 'INDEX_PLATFORM_UNREVIEWED')
            await copyManifest(child.digest, child.mediaType, child.size, executable, depth + 1)
          }
        } else {
          const value = manifest.value
          assert(value.config && Array.isArray(value.layers) && value.layers.length <= 128, 'IMAGE_MANIFEST_INVALID')
          await copyBlob(value.config, runtime ? 'CONFIG_RUNTIME' : 'CONFIG_ATTESTATION')
          for (const layer of value.layers) await copyBlob(layer, 'LAYER')
        }
        await putManifest(target, image.repo, digest, manifest, digest)
        return manifest
      }
      const root = await copyManifest(image.digest, undefined, undefined, true, 0)
      assert(runtimeConfigs === 1, `${image.artifact}_RUNTIME_PLATFORM_COUNT_INVALID`)
      const recheck = await request(apiUrl(target, image.repo, 'manifests', identity.release_id),
        { method: 'HEAD', headers: { accept: ACCEPT } }, [200, 404], 'TARGET_TAG_RECHECK')
      assert(recheck.status === 404, `${image.artifact}_TARGET_TAG_RACED`)
      await putManifest(target, image.repo, identity.release_id, root, image.digest)
      records.push({ artifact: image.artifact, repository: image.repo, digest: image.digest,
        target_reference: image.targetReference, manifests_verified: seenManifests.size,
        blobs_verified: seenBlobs.size, blob_bytes_verified: blobBytes, runtime_configs_verified: runtimeConfigs })
    }
    const destinationReleaseImages = {
      schema_version: 1, release_id: identity.release_id, release_git_sha: identity.release_git_sha,
      source_sha256: identity.source_sha256, npm_registry: identity.npm_registry,
      image_digests: Object.fromEntries(records.map(item => [item.artifact, item.digest])),
      image_references: Object.fromEntries(records.map(item => [item.artifact, item.target_reference])),
    }
    return Object.freeze({ schema_version: 'oci-release-loopback-copy/1', status: 'copied_and_verified',
      release_id: identity.release_id, release_git_sha: identity.release_git_sha, source_sha256: identity.source_sha256,
      source_registry: source.origin, target_transport: target.origin, target_reference_host: input.targetReferenceHost,
      images: records, destination_release_images: destinationReleaseImages,
      cryptographic_signature_verified: false, production_authorized: false })
  } finally { await rm(work, { recursive: true, force: true }) }
}

function args(argv) {
  const allowed = new Set(['release-images', 'source-registry', 'target-registry', 'target-reference-host', 'expected-git-sha', 'expected-source-sha256', 'output', 'output-release-images'])
  const parsed = {}
  assert(argv.length === allowed.size * 2, 'CLI_ARGUMENTS_INVALID')
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.startsWith('--') ? argv[i].slice(2) : ''
    assert(allowed.has(key) && argv[i + 1] && !Object.hasOwn(parsed, key), 'CLI_ARGUMENTS_INVALID')
    parsed[key] = argv[i + 1]
  }
  assert(Object.keys(parsed).length === allowed.size && parsed['target-registry'] === 'http://127.0.0.1:5501' &&
    parsed['source-registry'] === 'http://127.0.0.1:5002', 'CLI_REGISTRY_ENDPOINT_INVALID')
  return parsed
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = args(process.argv.slice(2))
    const output = resolve(options.output)
    const outputImages = resolve(options['output-release-images'])
    assert(output !== outputImages && dirname(output) === dirname(outputImages), 'OUTPUT_PATHS_INVALID')
    const outputParent = dirname(output)
    const parent = await stat(outputParent)
    assert(parent.isDirectory() && parent.uid === process.getuid() && (parent.mode & 0o077) === 0 &&
      realpathSync(outputParent) === outputParent, 'OUTPUT_PARENT_UNSAFE')
    for (const candidate of [output, outputImages]) {
      try { lstatSync(candidate); fail('OUTPUT_ALREADY_EXISTS') }
      catch (error) { if (error?.code !== 'ENOENT') throw error }
    }
    const path = resolve(options['release-images'])
    const info = lstatSync(path)
    assert(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size < 2 * 1024 * 1024 &&
      (info.mode & 0o077) === 0, 'RELEASE_IMAGES_FILE_INVALID')
    const report = await copyRelease({ releaseImages: JSON.parse(readFileSync(path, 'utf8')),
      sourceRegistry: options['source-registry'], targetRegistry: options['target-registry'],
      targetReferenceHost: options['target-reference-host'], expectedGitSha: options['expected-git-sha'],
      expectedSourceSha256: options['expected-source-sha256'] })
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await writeFile(outputImages, `${JSON.stringify(report.destination_release_images, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    process.stdout.write(`${JSON.stringify({ status: report.status, release_id: report.release_id, images: report.images.length, output, output_release_images: outputImages })}\n`)
  } catch (error) { console.error(error instanceof Error ? error.message : 'OCI_RELEASE_COPY_UNKNOWN_ERROR'); process.exitCode = 1 }
}
