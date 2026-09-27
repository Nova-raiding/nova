// Shape review for a proposed 242→254 forward-only recovery capsule. This
// does not read the database, verify signatures, consume a nonce, or authorize
// a deploy. An independently installed controller must do all of those.

const SHA = /^[a-f0-9]{64}$/u
const IMAGE = /^sha256:[a-f0-9]{64}$/u
const GIT = /^[a-f0-9]{40}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const SERVICES = Object.freeze(['api', 'api-replica', 'worker-automation', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-scan', 'worker-sync'])
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
const identity = value => keys(value, ['release_id', 'git_sha', 'manifest_sha256', 'image_set_digest'])
  && ID.test(value.release_id) && GIT.test(value.git_sha) && SHA.test(value.manifest_sha256) && IMAGE.test(value.image_set_digest)
const canonicalTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value

export function reviewBridge254CapsuleShape(document, expected, now = new Date()) {
  const errors = []
  const add = (condition, message) => { if (!condition) errors.push(message) }
  add(keys(document, ['schema_version', 'kind', 'created_at', 'expires_at', 'compose_project', 'current', 'target', 'database', 'volumes']), 'capsule fields must match the reviewed schema exactly')
  if (!document || typeof document !== 'object' || Array.isArray(document)) return { status: 'review_only', structure_consistent: false, deployable: false, signature_verified: false, runtime_verified: false, source_provenance_verified: false, errors }
  add(document.schema_version === '1' && document.kind === 'ecs-compose-rollback-capsule', 'capsule schema and kind are invalid')
  add(document.compose_project === 'merchant-production', 'Compose project must be merchant-production')
  const created = Date.parse(document.created_at), expires = Date.parse(document.expires_at)
  add(canonicalTime(document.created_at) && canonicalTime(document.expires_at)
    && created <= now.getTime() + 300_000 && expires > now.getTime() && expires - created <= 86_400_000,
  'capsule must have a current canonical UTC lifetime of at most 24 hours')
  add(identity(document.current), 'current candidate identity is invalid')
  add(identity(document.target && Object.fromEntries(['release_id', 'git_sha', 'manifest_sha256', 'image_set_digest'].map(key => [key, document.target[key]]))), 'bridge target identity is invalid')
  if (identity(document.current) && expected?.candidate) add(Object.entries(expected.candidate).every(([key, value]) => document.current[key] === value), 'current candidate differs from the frozen expected identity')
  if (identity(document.target && Object.fromEntries(['release_id', 'git_sha', 'manifest_sha256', 'image_set_digest'].map(key => [key, document.target[key]]))) && expected?.bridge) {
    add(Object.entries(expected.bridge).every(([key, value]) => document.target[key] === value), 'bridge target differs from the frozen expected identity')
  }
  add(expected && identity(expected.candidate) && identity(expected.bridge) && expected.candidate.release_id !== expected.bridge.release_id,
    'independent expected candidate and bridge identities are required')
  const target = document.target
  add(keys(target, ['release_id', 'git_sha', 'manifest_sha256', 'image_set_digest', 'compose_sha256', 'env_sha256', 'image_digests_sha256', 'services'])
    && SHA.test(target.compose_sha256) && SHA.test(target.env_sha256) && SHA.test(target.image_digests_sha256), 'bridge target must bind exact Compose, env, and image-digest bytes')
  add(Array.isArray(target?.services) && target.services.length === SERVICES.length && new Set(target.services).size === SERVICES.length
    && SERVICES.every(service => target.services.includes(service)), 'bridge target must contain exactly API, replica, and six workers')
  add(keys(document.volumes, ['preserve']) && document.volumes.preserve === true, 'volumes must be preserved')
  const database = document.database
  add(keys(database, ['strategy', 'schema_downgrade', 'live_migration_version', 'target_migration_tail', 'allowed_prefix_sha256'])
    && database.strategy === 'forward_only' && database.schema_downgrade === false && database.target_migration_tail === 254
    && Number.isSafeInteger(database.live_migration_version) && database.live_migration_version >= 242 && database.live_migration_version <= 254,
  'database must be forward-only from a 242–254 prefix to exactly 254')
  const prefixes = database?.allowed_prefix_sha256
  add(keys(prefixes, Array.from({ length: 13 }, (_, index) => String(index + 242)))
    && Object.values(prefixes).every(value => SHA.test(value)), 'all and only migration prefixes 242–254 require SHA-256 digests')
  add(expected && Number.isSafeInteger(expected.observedPrefix?.version) && SHA.test(expected.observedPrefix?.historySha256 ?? '')
    && database?.live_migration_version === expected.observedPrefix.version
    && prefixes?.[expected.observedPrefix.version] === expected.observedPrefix.historySha256,
  'claimed live prefix must match the independently supplied observation')
  return { status: 'review_only', structure_consistent: errors.length === 0, deployable: false, signature_verified: false, runtime_verified: false, source_provenance_verified: false, errors }
}

export { SERVICES as BRIDGE_254_RUNTIME_SERVICES }
