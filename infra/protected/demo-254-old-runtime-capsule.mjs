// Review-only contract for the mixed live demo runtime at migration 254.
// A protected host collector and signer must supply trusted observations before
// this can be used for recovery. A passing review never authorizes mutation.
import { createHash } from 'node:crypto'

const SHA = /^[a-f0-9]{64}$/u
const IMAGE = /^sha256:[a-f0-9]{64}$/u
const RELEASE = /^release-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u
const PROJECT = 'merchant-demo-85575f9c'
const REPLACE = Object.freeze(['api', 'api-replica', 'worker-sync', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-automation'])
const PRESERVE = Object.freeze(['pilot-gateway', 'ui', 'ops-ui', 'payment-gateway', 'postgres', 'redis'])
const FIELDS = Object.freeze(['role', 'container_id', 'image_id', 'image_ref', 'compose_file', 'compose_sha256', 'env_file', 'env_sha256', 'config_hash', 'network_sha256', 'mounts_sha256'])
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value)
const digest = value => createHash('sha256').update(canonical(value)).digest('hex')
const exactKeys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...names].sort().join('\0')
const same = (a, b) => canonical(a) === canonical(b)

export const DEMO_254_REPLACE_SERVICES = REPLACE
export const DEMO_254_PRESERVE_SERVICES = PRESERVE

function validService(item, role, immutable) {
  return exactKeys(item, FIELDS) && item.role === role && SHA.test(item.container_id)
    && IMAGE.test(item.image_id) && typeof item.image_ref === 'string'
    && (!immutable || /@sha256:[a-f0-9]{64}$/u.test(item.image_ref))
    && typeof item.compose_file === 'string'
    && item.compose_file.startsWith('/var/lib/merchant-release-security/')
    && item.compose_file.endsWith('/candidate.compose.json')
    && SHA.test(item.compose_sha256) && typeof item.env_file === 'string'
    && item.env_file.startsWith('/var/lib/merchant-release-security/')
    && SHA.test(item.env_sha256) && SHA.test(item.config_hash)
    && SHA.test(item.network_sha256) && SHA.test(item.mounts_sha256)
}

function validRoleSet(items, roles, immutable) {
  return Array.isArray(items) && items.length === roles.length
    && items.every((item, index) => validService(item, roles[index], immutable))
    && new Set(items.map(item => item.container_id)).size === roles.length
}

export function reviewDemo254OldRuntimeCapsule(capsule, observed, expected, now = new Date()) {
  const errors = []
  const check = (ok, code) => { if (!ok) errors.push(code) }
  const base = { status: 'review_only', deployable: false, signature_verified: false,
    database_verified: false, recovery_exercised: false }
  if (!exactKeys(capsule, ['schema_version', 'created_at', 'expires_at', 'project', 'public_release',
    'database', 'replace', 'preserve', 'external_consumers', 'recovery'])) {
    return { ...base, structure_consistent: false, errors: ['CAPSULE_SHAPE_INVALID'] }
  }
  check(capsule.schema_version === 'demo-254-old-runtime-capsule/1' && capsule.project === PROJECT, 'PROJECT_INVALID')
  const created = Date.parse(capsule.created_at), expires = Date.parse(capsule.expires_at)
  check(Number.isFinite(created) && Number.isFinite(expires)
    && new Date(created).toISOString() === capsule.created_at
    && new Date(expires).toISOString() === capsule.expires_at
    && created <= now.getTime() + 300_000 && expires > now.getTime()
    && expires - created <= 86_400_000, 'LIFETIME_INVALID')
  const identity = capsule.public_release
  check(exactKeys(identity, ['release_id', 'git_sha', 'manifest_sha256', 'image_set_digest'])
    && RELEASE.test(identity?.release_id ?? '') && /^[a-f0-9]{40}$/u.test(identity?.git_sha ?? '')
    && SHA.test(identity?.manifest_sha256 ?? '') && IMAGE.test(identity?.image_set_digest ?? ''), 'PUBLIC_IDENTITY_INVALID')
  check(same(identity, expected?.public_release) && same(identity, observed?.public_release), 'PUBLIC_IDENTITY_DRIFT')
  check(exactKeys(capsule.database, ['version', 'history_sha256', 'volume_name', 'backup_capture_sha256'])
    && capsule.database.version === 254 && SHA.test(capsule.database.history_sha256)
    && capsule.database.volume_name === `${PROJECT}_merchant-postgres`
    && SHA.test(capsule.database.backup_capture_sha256), 'DATABASE_BINDING_INVALID')
  check(same(capsule.database, expected?.database) && same(capsule.database, observed?.database), 'DATABASE_DRIFT')
  check(validRoleSet(capsule.replace, REPLACE, true), 'REPLACE_SET_INVALID')
  check(validRoleSet(capsule.preserve, PRESERVE, false), 'PRESERVE_SET_INVALID')
  const managedIds = [...(Array.isArray(capsule.replace) ? capsule.replace : []),
    ...(Array.isArray(capsule.preserve) ? capsule.preserve : [])].map(item => item?.container_id)
  check(managedIds.length === REPLACE.length + PRESERVE.length
    && new Set(managedIds).size === managedIds.length, 'MANAGED_CONTAINER_DUPLICATE')
  check(same(capsule.replace, observed?.replace) && same(capsule.preserve, observed?.preserve), 'CONTAINER_OR_SOURCE_DRIFT')
  check(Array.isArray(capsule.external_consumers) && capsule.external_consumers.length > 0
    && capsule.external_consumers.every(item => exactKeys(item, ['role', 'container_id', 'database_target_sha256', 'queue_target_sha256', 'disposition'])
      && typeof item.role === 'string' && SHA.test(item.container_id)
      && SHA.test(item.database_target_sha256) && SHA.test(item.queue_target_sha256)
      && ['isolated', 'included_in_drain', 'proven_unrelated'].includes(item.disposition))
    && new Set(capsule.external_consumers.map(item => item.container_id)).size === capsule.external_consumers.length
    && capsule.external_consumers.every(item => !managedIds.includes(item.container_id))
    && same(capsule.external_consumers, observed?.external_consumers), 'EXTERNAL_CONSUMER_UNRESOLVED')
  check(exactKeys(capsule.recovery, ['strategy', 'schema_downgrade', 'volumes_preserve', 'gateway_preserve', 'database_target_version'])
    && capsule.recovery.strategy === 'forward_only' && capsule.recovery.schema_downgrade === false
    && capsule.recovery.volumes_preserve === true && capsule.recovery.gateway_preserve === true
    && capsule.recovery.database_target_version === 254, 'RECOVERY_POLICY_INVALID')
  return { ...base, structure_consistent: errors.length === 0, capsule_sha256: digest(capsule), errors }
}
