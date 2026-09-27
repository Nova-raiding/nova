#!/usr/bin/env node
// Render a four-service, non-public first-install candidate. This creates
// protected configuration only; it does not call providers or start Docker.
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const fail = message => { throw new Error(message) }
const testMode = process.env.NODE_ENV === 'test' && process.env.VITEST === 'true' && process.env.DEMO_CANDIDATE_TEST_UNPROTECTED_FILES === 'true'
const allowedArtifacts = ['merchant-api', 'merchant-worker', 'merchant-ui', 'merchant-ops-ui', 'payment-gateway', 'pilot-gateway']
const eightArtifacts = [...allowedArtifacts, 'postgres-migration', 'clamav']
const approvedModels = ['qwen3.7-text-embedding-flash', 'qwen3.7-text-embedding']
const hash = value => createHash('sha256').update(value).digest('hex')

function options(argv) {
  const allowed = new Set(['identity', 'release-images', 'eight-image-set', 'root-env', 'source-root', 'output-dir', 'project', 'redis-image', 'embedding-model'])
  const result = {}
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.startsWith('--') ? argv[i].slice(2) : ''
    if (!allowed.has(name) || !argv[i + 1] || argv[i + 1].startsWith('--') || Object.hasOwn(result, name)) fail('invalid or duplicate command argument')
    result[name] = argv[i + 1]
  }
  for (const name of allowed) if (!result[name] && !['embedding-model'].includes(name)) fail(`--${name} is required`)
  return result
}

function inspectPath(path, label, kind, { secret = false } = {}) {
  if (!path.startsWith('/') || resolve(path) !== path) fail(`${label} must be absolute and canonical`)
  let real
  try { real = realpathSync(path) } catch { fail(`${label} is missing or inaccessible`) }
  if (real !== path) fail(`${label} must not traverse symlinks`)
  let details
  try { details = lstatSync(path) } catch { fail(`${label} is missing or inaccessible`) }
  if (details.isSymbolicLink() || (kind === 'file' ? !details.isFile() : !details.isDirectory())) fail(`${label} has an unsafe file type`)
  if (!testMode && details.uid !== 0) fail(`${label} must be root-owned`)
  if (secret) {
    if ((details.mode & 0o777) !== 0o600) fail(`${label} must have mode 0600`)
  } else if ((details.mode & 0o022) !== 0) fail(`${label} must not be group/other writable`)
  let parent = dirname(path)
  while (parent !== '/') {
    let parentDetails
    try { parentDetails = lstatSync(parent) } catch { fail(`${label} parent chain is missing`) }
    if (!parentDetails.isDirectory() || parentDetails.isSymbolicLink() || (!testMode && parentDetails.uid !== 0) || (!testMode && (parentDetails.mode & 0o022) !== 0)) fail(`${label} parent chain is unsafe`)
    parent = dirname(parent)
  }
  return details
}

function parseIdentity(path) {
  const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/u)
  const identity = {}
  for (const line of lines) {
    const split = line.indexOf('=')
    if (split < 1) fail('candidate identity is malformed')
    const key = line.slice(0, split), value = line.slice(split + 1)
    if (Object.hasOwn(identity, key) || !value) fail('candidate identity has duplicate or empty fields')
    identity[key] = value
  }
  if (!/^(?:release|ecs)-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(identity.release_id ?? '') ||
      !/^[0-9a-f]{40}$/u.test(identity.git_sha ?? '') || !/^sha256:[0-9a-f]{64}$/u.test(identity.source_sha256 ?? '')) fail('candidate identity is incomplete')
  return identity
}

function parseRootRelayEnvironment(path) {
  const values = new Map()
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(trimmed)
    if (!match || match[1] !== 'MODEL_RELAY_API_KEY' || values.has(match[1])) fail('root env must contain only one MODEL_RELAY_API_KEY assignment')
    const value = match[2]
    if (!/^[A-Za-z0-9][A-Za-z0-9._~+/-]{0,4093}={0,2}$/u.test(value) || /^(?:change-me|placeholder|dummy|example|your-secret)$/iu.test(value)) fail('root relay key is malformed or a placeholder')
    values.set(match[1], value)
  }
  if (values.size !== 1) fail('root env is missing MODEL_RELAY_API_KEY')
  return values.get('MODEL_RELAY_API_KEY')
}

function immutableReference(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[0-9a-f]{64}$/u.test(value)) fail(`${label} must be an immutable repository@sha256 reference`)
  return value
}

function assertSourceBoundToIdentity(sourceRoot, identityPath, identity) {
  if (identityPath !== join(sourceRoot, '.candidate-identity')) fail('candidate identity must come from the selected source root')
  const bundledIdentity = parseIdentity(join(sourceRoot, '.candidate-identity'))
  for (const key of ['release_id', 'git_sha', 'source_sha256']) if (bundledIdentity[key] !== identity[key]) fail('source-root candidate identity differs from the explicit identity')
  const archivePath = join(sourceRoot, '.candidate-source.tar')
  inspectPath(archivePath, 'source archive', 'file')
  if (`sha256:${hash(readFileSync(archivePath))}` !== identity.source_sha256) fail('source archive digest differs from the candidate identity')
  const migrationDir = join(sourceRoot, 'packages/persistence/src/migrations')
  const migrationScript = join(sourceRoot, 'infra/scripts/apply-migrations.sh')
  const migrationNames = readdirSync(migrationDir).filter(name => name.endsWith('.sql')).sort()
  if (!migrationNames.length || migrationNames.some(name => !/^\d{3}_[a-z0-9][a-z0-9_]*\.sql$/u.test(name))) fail('source migration directory has an invalid artifact set')
  const mountedFiles = [
    ...migrationNames.map(name => [`packages/persistence/src/migrations/${name}`, join(migrationDir, name)]),
    ['infra/scripts/apply-migrations.sh', migrationScript],
  ]
  const archiveEntries = execFileSync('tar', ['-tf', archivePath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split(/\r?\n/u).filter(Boolean)
  for (const [member, localPath] of mountedFiles) {
    if (archiveEntries.filter(entry => entry === member).length !== 1) fail('source archive must contain each mounted migration input exactly once')
    const local = readFileSync(localPath)
    const archived = execFileSync('tar', ['-xOf', archivePath, member], { maxBuffer: 8 * 1024 * 1024 })
    if (!archived.equals(local)) fail('mounted migration input differs from the candidate source archive')
  }
  const relevant = archiveEntries.filter(entry => /^packages\/persistence\/src\/migrations\/\d{3}_[a-z0-9][a-z0-9_]*\.sql$/u.test(entry) || entry === 'infra/scripts/apply-migrations.sh')
  if (relevant.length !== mountedFiles.length) fail('source archive contains an unreviewed migration input')
}

function newSecret() { return randomBytes(24).toString('hex') }
function databaseUrl(role, password) { return `postgres://${role}:${password}@postgres:5432/merchant` }

export function validateDemoCompose(compose, project) {
  const services = compose?.services ?? {}
  const required = ['postgres', 'redis', 'migrate', 'api']
  if (Object.keys(services).sort().join(',') !== [...required].sort().join(',')) fail('candidate Compose must contain exactly postgres, redis, migrate, and api')
  for (const name of required) {
    const service = services[name]
    const ports = service?.ports
    if (!service || typeof service !== 'object' || service.build || (ports !== undefined && (!Array.isArray(ports) || ports.length > 0)) || service.network_mode || service.container_name || service.privileged || service.pid || service.ipc || service.devices?.length || service.cap_add?.length || service.extra_hosts?.length || service.links?.length || service.volumes_from?.length) fail(`${name} must have no host ports, host namespaces, or privileged access`)
    if (service.networks && (Object.keys(service.networks).length !== 1 || !Object.hasOwn(service.networks, 'default'))) fail(`${name} cannot join a shared or external network`)
    for (const mount of service.volumes ?? []) {
      const source = typeof mount === 'string' ? mount.split(':')[0] : mount.source
      const readOnly = typeof mount === 'string' ? mount.split(':').includes('ro') : mount.read_only === true
      const bind = typeof mount === 'string' ? source?.startsWith('/') : mount.type === 'bind'
      if (bind && !readOnly) fail(`${name} has an absolute writable host bind mount`)
    }
  }
  const expectedVolumes = [`${project}_postgres_data`, `${project}_redis_data`].sort()
  const volumes = compose.volumes ?? {}
  const actualVolumes = Object.values(volumes).map(value => value?.name).sort()
  if (Object.keys(volumes).length !== 2 || actualVolumes.join(',') !== expectedVolumes.join(',')) fail('candidate data volumes must be new project-scoped volumes')
  for (const value of Object.values(volumes)) if (value?.external) fail('candidate data volumes must not be external')
  const postgresMounts = services.postgres.volumes ?? []
  const redisMounts = services.redis.volumes ?? []
  if (postgresMounts.length !== 1 || postgresMounts[0]?.source !== 'postgres_data' || postgresMounts[0]?.target !== '/var/lib/postgresql/data' || postgresMounts[0]?.type !== 'volume' ||
      redisMounts.length !== 1 || redisMounts[0]?.source !== 'redis_data' || redisMounts[0]?.target !== '/data' || redisMounts[0]?.type !== 'volume') fail('candidate databases must use only their new project-scoped data volumes')
  const networks = compose.networks ?? {}
  if (Object.keys(networks).length !== 1 || !networks.default || networks.default.external || networks.default.name !== `${project}_private`) fail('candidate network must be a new project-scoped private network')
  if (networks.default.internal === true) fail('candidate network must allow outbound provider TLS while remaining unpublished')
  const api = services.api
  const env = api.environment ?? {}
  if (env.KNOWLEDGE_VECTOR_INDEX_ENABLED !== 'false' || env.EMBEDDING_DIMENSIONS !== '1024' || !approvedModels.includes(env.EMBEDDING_MODEL)) fail('embedding must remain disabled with an approved Qwen 1024 configuration')
  if (env.PLUGIN_WRITE_ENABLED !== 'false' || env.ASSET_STORAGE_PREFIX !== `demo-candidate/${env.RELEASE_ID}`) fail('candidate API writes must be disabled and release-scoped')
  if (env.RELEASE_ID !== api.labels?.['com.storenova.release.id'] || env.RELEASE_GIT_SHA !== api.labels?.['org.opencontainers.image.revision'] || env.RELEASE_GIT_SHA.length !== 40 || !/^sha256:[0-9a-f]{64}$/u.test(api.labels?.['com.storenova.release.source_sha256'] ?? '')) fail('candidate API environment and immutable image identity differ')
  if (api.env_file?.length !== 1 || api.env_file[0]?.path !== compose['x-candidate-env-path'] || api.env_file[0]?.required !== true) fail('candidate relay key must come from the protected generated env file')
  if (JSON.stringify(compose).includes('MODEL_RELAY_API_KEY=')) fail('candidate Compose must not inline the relay key')
  immutableReference(api.image, 'api image')
  const parseDb = (value, role) => {
    let url
    try { url = new URL(value) } catch { fail(`${role} database URL is invalid`) }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== 'postgres' || (url.port && url.port !== '5432') || url.username !== role || !/^[0-9a-f]{48}$/u.test(url.password) || url.pathname !== '/merchant') fail(`${role} database URL must target a fresh isolated role`)
    return value
  }
  parseDb(env.DATABASE_URL, 'merchant_app')
  parseDb(env.OPS_DATABASE_URL, 'merchant_ops')
  parseDb(env.ALERT_RECEIVER_DATABASE_URL, 'merchant_alert_receiver')
  const migrationEnv = services.migrate.environment ?? {}
  if (migrationEnv.PGHOST !== 'postgres' || migrationEnv.DATABASE_URL !== env.DATABASE_URL || migrationEnv.OPS_DATABASE_URL !== env.OPS_DATABASE_URL || migrationEnv.ALERT_RECEIVER_DATABASE_URL !== env.ALERT_RECEIVER_DATABASE_URL) fail('migration service must use the candidate postgres roles')
  let redisUrl
  try { redisUrl = new URL(env.REDIS_URL) } catch { fail('candidate API Redis URL is invalid') }
  if (redisUrl.protocol !== 'redis:' || redisUrl.hostname !== 'redis' || (redisUrl.port && redisUrl.port !== '6379')) fail('candidate API Redis URL must target isolated Compose Redis')
  if (!/(?:^|\/)postgres:17-alpine@sha256:[0-9a-f]{64}$/u.test(immutableReference(services.postgres.image, 'postgres image')) ||
      !/(?:^|\/)postgres:17-alpine@sha256:[0-9a-f]{64}$/u.test(immutableReference(services.migrate.image, 'migration image')) ||
      !/(?:^|\/)redis:7-alpine@sha256:[0-9a-f]{64}$/u.test(immutableReference(services.redis.image, 'redis image'))) fail('candidate database images must use the reviewed immutable PostgreSQL 17 and Redis 7 images')
  const migrationBinds = (services.migrate.volumes ?? []).filter(value => value?.type === 'bind')
  if (migrationBinds.length !== 2 || migrationBinds.some(value => value.read_only !== true || !value.source?.startsWith('/'))) fail('migration sidecar may bind only the two readonly host inputs')
  return true
}

function render({ identity, images, eightImageSet, project, sourceRoot, envPath, embeddingModel, postgresImage, redisImage, migrationImage, relayKey }) {
  const rendererSha256 = hash(readFileSync(new URL(import.meta.url)))
  const roles = { merchant_app: newSecret(), merchant_ops: newSecret(), merchant_alert_receiver: newSecret() }
  const adminPassword = newSecret()
  const urls = Object.fromEntries(Object.entries(roles).map(([role, password]) => [role, databaseUrl(role, password)]))
  const imageRefs = { ...eightImageSet.image_references, 'candidate-redis': redisImage }
  const imageDigests = Object.fromEntries(Object.entries(imageRefs).map(([name, ref]) => [name, ref.slice(ref.lastIndexOf('@') + 1)]))
  const imageSetDigest = `sha256:${hash(Object.keys(eightImageSet.image_digests).sort().map(key => `${key}=${eightImageSet.image_digests[key]}\n`).join(''))}`
  const manifest = {
    schema: 'isolated-demo-candidate/1', release_id: identity.release_id, release_git_sha: identity.git_sha,
    source_sha256: identity.source_sha256, image_digests: imageDigests, image_references: imageRefs,
    renderer_sha256: rendererSha256,
    deployment_scope: 'isolated_four_service_candidate', public_ports: [], embedding_enabled: false,
    embedding_model: embeddingModel, embedding_dimensions: 1024,
  }
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
  const manifestSha = hash(manifestText)
  const apiImage = images.image_references['merchant-api']
  const migrations = join(sourceRoot, 'packages/persistence/src/migrations')
  const migrateScript = join(sourceRoot, 'infra/scripts/apply-migrations.sh')
  const compose = {
    name: project,
    'x-eight-image-set-digest': imageSetDigest,
    services: {
      postgres: {
        image: postgresImage, restart: 'no', environment: { POSTGRES_USER: 'merchant', POSTGRES_PASSWORD: adminPassword, POSTGRES_DB: 'merchant' },
        volumes: [{ type: 'volume', source: 'postgres_data', target: '/var/lib/postgresql/data' }],
        healthcheck: { test: ['CMD-SHELL', 'pg_isready -U merchant -d merchant'], interval: '2s', timeout: '3s', retries: 60 },
      },
      redis: {
        image: redisImage, restart: 'no', command: ['redis-server', '--save', '', '--appendonly', 'no'],
        volumes: [{ type: 'volume', source: 'redis_data', target: '/data' }],
        healthcheck: { test: ['CMD', 'redis-cli', 'ping'], interval: '2s', timeout: '3s', retries: 60 },
      },
      migrate: {
        image: migrationImage, restart: 'no', entrypoint: ['/bin/sh', '/ops/apply-migrations.sh'],
        environment: {
          PGHOST: 'postgres', PGPORT: '5432', PGDATABASE: 'merchant', PGUSER: 'merchant', PGPASSWORD: adminPassword, MIGRATION_BASELINE_ACCEPTED: 'false',
          DATABASE_URL: urls.merchant_app, OPS_DATABASE_URL: urls.merchant_ops, ALERT_RECEIVER_DATABASE_URL: urls.merchant_alert_receiver,
        },
        volumes: [
          { type: 'bind', source: migrations, target: '/migrations', read_only: true },
          { type: 'bind', source: migrateScript, target: '/ops/apply-migrations.sh', read_only: true },
        ],
      },
      api: {
        image: apiImage, restart: 'no', env_file: [{ path: envPath, required: true }], expose: ['8787'],
        labels: { 'com.storenova.release.id': identity.release_id, 'org.opencontainers.image.revision': identity.git_sha, 'com.storenova.release.source_sha256': identity.source_sha256 },
        environment: {
          RELEASE_ID: identity.release_id, RELEASE_GIT_SHA: identity.git_sha,
          RELEASE_MANIFEST_SHA256: manifestSha, RELEASE_IMAGE_SET_DIGEST: imageSetDigest,
          NODE_ENV: 'production', DEPLOYMENT_PROFILE: 'ecs', PORT: '8787', PUBLIC_BASE_URL: 'https://candidate.yxsona.com',
          RUN_MIGRATIONS_ON_STARTUP: 'false', CONNECTOR_FIXTURE_MODE: 'false', AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED: 'true',
          MCP_INTEGRATION_MODE: 'local_stdio', PERSISTENCE_MODE: 'postgres', OPS_AUTH_MODE: 'password',
          API_AUTH_TOKENS: '{}', SESSION_ID_HASH_SECRET: newSecret(), WORKER_API_CREDENTIALS: '{}',
          DATABASE_URL: urls.merchant_app, OPS_DATABASE_URL: urls.merchant_ops, ALERT_RECEIVER_DATABASE_URL: urls.merchant_alert_receiver,
          REDIS_URL: 'redis://redis:6379', PLUGIN_WRITE_ENABLED: 'false', ASSET_STORAGE_PREFIX: `demo-candidate/${identity.release_id}`,
          EMBEDDING_MODEL: embeddingModel, EMBEDDING_DIMENSIONS: '1024', EMBEDDING_VERSION: 'v1',
          KNOWLEDGE_VECTOR_INDEX_ENABLED: 'false', MODEL_RELAY_BASE_URL: 'https://ai.wormholexyz.xyz/v1',
          MODEL_RELAY_ALLOWED_HOSTS: 'ai.wormholexyz.xyz', MODEL_RELAY_EMBEDDING_COST_EVIDENCE: 'false',
          MODEL_COST_ESTIMATE_VERSION: 'isolated-candidate-review-only',
        },
      },
    },
    volumes: {
      postgres_data: { name: `${project}_postgres_data`, external: false },
      redis_data: { name: `${project}_redis_data`, external: false },
    },
    networks: { default: { name: `${project}_private`, external: false } },
    'x-candidate-env-path': envPath,
  }
  validateDemoCompose(compose, project)
  return { compose, envText: `MODEL_RELAY_API_KEY=${relayKey}\n`, identityText: `${Object.entries(identity).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, manifestText, manifestSha, imageSetDigest, rendererSha256 }
}

function createExclusive(path, contents, created) {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0)
  let fd
  try { fd = openSync(path, flags, 0o600) } catch { fail(`refusing to overwrite or follow output file: ${path.split('/').at(-1)}`) }
  created.push(path)
  try { writeFileSync(fd, contents, 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
}

export function main(argv = process.argv.slice(2)) {
  const args = options(argv)
  const project = args.project
  if (!/^merchant-demo-[a-z0-9][a-z0-9_-]{0,25}$/u.test(project)) fail('candidate project must be a dedicated merchant-demo-* name')
  const embeddingModel = args['embedding-model'] ?? approvedModels[0]
  if (!approvedModels.includes(embeddingModel)) fail('embedding model is not an approved Qwen model')
  const paths = {
    identity: resolve(args.identity), images: resolve(args['release-images']), eightImageSet: resolve(args['eight-image-set']), rootEnv: resolve(args['root-env']),
    sourceRoot: resolve(args['source-root']), outputDir: resolve(args['output-dir']),
  }
  for (const [path, label] of [[paths.identity, 'candidate identity'], [paths.images, 'six-image manifest'], [paths.eightImageSet, 'eight-image set'], [paths.rootEnv, 'root relay env']]) inspectPath(path, label, 'file', { secret: label === 'root relay env' })
  inspectPath(paths.sourceRoot, 'staged source root', 'directory')
  const outputDetails = inspectPath(paths.outputDir, 'candidate output directory', 'directory')
  if ((outputDetails.mode & 0o777) !== 0o700) fail('candidate output directory must have mode 0700')
  if (!testMode && outputDetails.uid !== 0) fail('candidate output directory must be root-owned')
  const migrationDir = join(paths.sourceRoot, 'packages/persistence/src/migrations')
  const migrateScript = join(paths.sourceRoot, 'infra/scripts/apply-migrations.sh')
  inspectPath(migrationDir, 'migration source', 'directory')
  inspectPath(migrateScript, 'migration runner', 'file')
  const envPath = join(paths.outputDir, 'candidate.env')
  const outputs = ['candidate.env', 'candidate.compose.json', 'candidate-identity.txt', 'candidate-manifest.json']
  for (const name of outputs) {
    try { lstatSync(join(paths.outputDir, name)); fail('candidate output already exists; refusing overwrite') }
    catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
  const identity = parseIdentity(paths.identity)
  assertSourceBoundToIdentity(paths.sourceRoot, paths.identity, identity)
  let images
  try { images = JSON.parse(readFileSync(paths.images, 'utf8')) } catch { fail('six-image manifest is invalid JSON') }
  if (images?.schema_version !== 1 || images.release_id !== identity.release_id || images.release_git_sha !== identity.git_sha || images.source_sha256 !== identity.source_sha256) fail('six-image manifest does not match the candidate identity')
  if (Object.keys(images.image_digests ?? {}).sort().join(',') !== [...allowedArtifacts].sort().join(',') || Object.keys(images.image_references ?? {}).sort().join(',') !== [...allowedArtifacts].sort().join(',')) fail('six-image manifest must contain exactly the approved six images')
  for (const artifact of allowedArtifacts) {
    const ref = immutableReference(images.image_references[artifact], `${artifact} image`)
    if (images.image_digests[artifact] !== ref.slice(ref.lastIndexOf('@') + 1)) fail('six-image digest/reference mismatch')
  }
  let eightImageSet
  try { eightImageSet = JSON.parse(readFileSync(paths.eightImageSet, 'utf8')) } catch { fail('eight-image set is invalid JSON') }
  if (eightImageSet?.schema_version !== 1 || eightImageSet.release_id !== identity.release_id || eightImageSet.release_git_sha !== identity.git_sha || eightImageSet.source_sha256 !== identity.source_sha256) fail('eight-image set does not match the candidate identity')
  if (Object.keys(eightImageSet.image_digests ?? {}).sort().join(',') !== [...eightArtifacts].sort().join(',') || Object.keys(eightImageSet.image_references ?? {}).sort().join(',') !== [...eightArtifacts].sort().join(',')) fail('eight-image set must contain exactly the approved eight images')
  for (const artifact of eightArtifacts) {
    const ref = immutableReference(eightImageSet.image_references[artifact], `${artifact} image`)
    if (eightImageSet.image_digests[artifact] !== ref.slice(ref.lastIndexOf('@') + 1)) fail('eight-image digest/reference mismatch')
    if (allowedArtifacts.includes(artifact) && images.image_references[artifact] !== ref) fail('six-image manifest and eight-image set disagree')
  }
  const postgresImage = eightImageSet.image_references['postgres-migration']
  const migrationImage = postgresImage
  const relayKey = parseRootRelayEnvironment(paths.rootEnv)
  if (!/(?:^|\/)postgres:17-alpine@sha256:[0-9a-f]{64}$/u.test(migrationImage)) fail('migration image must be immutable postgres:17-alpine')
  const redisImage = immutableReference(args['redis-image'], 'redis image')
  if (!/(?:^|\/)redis:7-alpine@sha256:[0-9a-f]{64}$/u.test(redisImage)) fail('isolated redis image must be immutable redis:7-alpine')
  const rendered = render({ identity, images, eightImageSet, project, sourceRoot: paths.sourceRoot, envPath, embeddingModel, postgresImage, redisImage, migrationImage, relayKey })
  const created = []
  try {
    createExclusive(join(paths.outputDir, 'candidate.env'), rendered.envText, created)
    createExclusive(join(paths.outputDir, 'candidate.compose.json'), `${JSON.stringify(rendered.compose, null, 2)}\n`, created)
    createExclusive(join(paths.outputDir, 'candidate-identity.txt'), rendered.identityText, created)
    createExclusive(join(paths.outputDir, 'candidate-manifest.json'), rendered.manifestText, created)
  } catch (error) {
    for (const path of created.reverse()) { try { unlinkSync(path) } catch {} }
    throw error
  }
  console.log(JSON.stringify({ status: 'config_rendered', release_id: identity.release_id, git_sha: identity.git_sha, project, services: ['postgres', 'redis', 'migrate', 'api'], public_ports: [], embedding_enabled: false, embedding_dimensions: 1024, image_set_digest: rendered.imageSetDigest, manifest_sha256: rendered.manifestSha, renderer_sha256: rendered.rendererSha256, outputs: outputs.map(name => name) }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main() } catch (error) { console.error(error instanceof Error ? error.message : 'candidate config rendering failed'); process.exitCode = 1 }
}
