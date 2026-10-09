// Configuration preparation only. No Docker, SSH, builds, migration or deploy.
import { createHash } from 'node:crypto'

const project = 'merchant-demo-85575f9c'
export const runtimeServices = Object.freeze(['api', 'api-replica', 'clamav', 'ops-ui', 'payment-gateway', 'pilot-gateway', 'postgres', 'redis', 'ui', 'worker-automation', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-scan', 'worker-sync'].sort())
const recreated = ['api', 'api-replica', 'ui']
const keys = ['RELEASE_ID', 'RELEASE_GIT_SHA', 'RELEASE_MANIFEST_SHA256', 'RELEASE_IMAGE_SET_DIGEST']
const sha = value => createHash('sha256').update(value).digest('hex')
const fail = message => { throw new Error(message) }
function assert(value, message) { if (!value) fail(message) }
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]))
  return value
}
// Existing Python drivers use json.dumps(..., ensure_ascii=True). Preserve
// that byte contract for non-ASCII configuration values as well as ASCII.
const asciiJson = value => value.replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
export const canonicalJson = value => asciiJson(JSON.stringify(ordered(value)))
const document = value => asciiJson(JSON.stringify(ordered(value), null, 2)) + '\n'
const same = (a, b) => canonicalJson(a) === canonicalJson(b)
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value)
const git = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value)
const immutable = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u.test(value)
function exactNames(value, names, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value) && same(Object.keys(value).sort(), [...names].sort()), `${label} has an unexpected service/field set`)
}
function identity(value) {
  exactNames(value, keys, 'release identity')
  assert(/^(?:release|ecs)-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(value.RELEASE_ID ?? '') && git(value.RELEASE_GIT_SHA) && /^[a-f0-9]{64}$/u.test(value.RELEASE_MANIFEST_SHA256 ?? '') && digest(value.RELEASE_IMAGE_SET_DIGEST), 'invalid release identity')
}
export function imageSetDigest(records) {
  return `sha256:${sha(Object.keys(records).sort().map(name => `${name}=${records[name].reference}|${records[name].image_id}\n`).join(''))}`
}
function stripIdentity(compose) {
  const result = structuredClone(compose)
  // Match the existing demo-runtime-service-set/1 configuration hash contract.
  for (const service of Object.values(result.services)) for (const key of keys) delete service.environment?.[key]
  return result
}
function parseDocument(text, label) {
  assert(typeof text === 'string' && text.length > 0, `${label} bytes missing`)
  try { return JSON.parse(text) } catch { fail(`${label} is not JSON`) }
}
function migrations(rows) {
  assert(Array.isArray(rows) && rows.length === 270, 'no-migration route requires the complete 270-row chain')
  for (const [index, row] of rows.entries()) {
    assert(row && row.version === index + 1 && typeof row.name === 'string' && /^\d{3}_[a-z0-9_]+(?:\.sql)?$/u.test(row.name) && /^[a-f0-9]{64}$/u.test(row.checksum ?? ''), 'invalid migration version/name/checksum')
  }
}

/** Inputs are owner-collected evidence, not a replacement for live inspection.
 * Compose can contain secrets: the owner must keep inputs/outputs protected.
 * Pure API never mutates its input, never obtains credentials or invokes tools.
 */
export function prepareDemoComponentUpdate(input) {
  assert(input?.schema_version === 'demo-component-update-input/1' && input.compose_project === project, 'only the reviewed Demo project is supported')
  const baseline = input.baseline
  const original = parseDocument(baseline?.compose_text, 'baseline Compose')
  const prior = parseDocument(baseline?.manifest_text, 'baseline manifest')
  const priorIdentity = baseline?.identity
  identity(priorIdentity)
  assert(sha(baseline.manifest_text) === priorIdentity.RELEASE_MANIFEST_SHA256, 'baseline manifest bytes do not match identity')
  assert(prior.schema_version === 'demo-runtime-service-set/1' && prior.compose_project === project && prior.release_id === priorIdentity.RELEASE_ID && prior.candidate_git_sha === priorIdentity.RELEASE_GIT_SHA && prior.image_set_digest === priorIdentity.RELEASE_IMAGE_SET_DIGEST, 'baseline manifest identity differs')
  assert(same(baseline.public_identity, priorIdentity), 'public release identity differs from baseline')
  exactNames(original.services, [...runtimeServices, 'migrate'], 'baseline Compose')
  exactNames(prior.services, runtimeServices, 'baseline manifest')
  exactNames(baseline.runtime_services, runtimeServices, 'actual runtime')
  assert(imageSetDigest(prior.services) === prior.image_set_digest, 'baseline image set differs')
  assert(sha(canonicalJson(stripIdentity(original))) === prior.configuration_contract_sha256, 'baseline configuration contract differs')
  migrations(baseline.migrations)
  migrations(input.target_migrations)
  assert(same(baseline.migrations, input.target_migrations) && prior.migration_version === 270 && prior.migration_chain_sha256 === sha(canonicalJson(baseline.migrations)), 'migration chain drift; no DDL/restore is permitted')
  const baselineIds = {}
  for (const name of runtimeServices) {
    const current = baseline.runtime_services[name], record = prior.services[name], service = original.services[name]
    exactNames(current, ['container_id', 'reference', 'image_id', 'git_sha', 'source_sha256', 'running', 'health', 'restarts', 'oom_killed', 'compose_service_sha256'], `${name} safe runtime projection`)
    assert(/^[a-f0-9]{64}$/u.test(current.container_id ?? '') && digest(current.image_id) && current.running === true && current.health === 'healthy' && current.restarts === 0 && current.oom_killed === false, `${name} runtime is not a healthy frozen baseline`)
    assert(current.reference === service.image && current.reference === record.reference && current.image_id === record.image_id && current.git_sha === record.git_sha, `${name} actual image identity differs`)
    assert(current.compose_service_sha256 === sha(canonicalJson(service)), `${name} reviewed runtime configuration differs`)
    if (['postgres', 'redis', 'clamav'].includes(name)) {
      assert((current.git_sha === null || git(current.git_sha)) && (current.source_sha256 === null || digest(current.source_sha256)), `${name} upstream identity malformed`)
      assert(immutable(current.reference) || (['postgres', 'redis'].includes(name) && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(current.reference)), `${name} upstream reference malformed`)
    } else {
      assert(immutable(current.reference) && git(current.git_sha) && digest(current.source_sha256), `${name} owned image metadata incomplete`)
    }
    if (record.source_sha256 !== undefined) assert(record.source_sha256 === current.source_sha256, `${name} source digest differs`)
    baselineIds[name] = current.container_id
  }
  assert(new Set(Object.values(baselineIds)).size === runtimeServices.length, 'duplicate runtime container identity')
  for (const name of ['api', 'api-replica']) {
    const env = original.services[name].environment
    assert(env && keys.every(key => env[key] === priorIdentity[key]), `${name} baseline release environment differs`)
    assert(env.MCP_INTEGRATION_MODE === 'local_stdio' && env.OPS_AUTH_MODE === 'password' && env.RUN_MIGRATIONS_ON_STARTUP === 'false', `${name} runtime security/no-DDL contract differs`)
    assert(!['MCP_OAUTH_REQUIRED', 'MCP_OAUTH_CLIENTS', 'MCP_OAUTH_ISSUER', 'OIDC_PROXY_SIGNING_SECRET'].some(key => Object.hasOwn(env, key)), 'unapproved host OAuth configuration')
  }
  const target = input.candidate, images = input.component_images, imported = input.imported_ui
  assert(target && git(target.git_sha) && digest(target.source_sha256) && /^(?:release|ecs)-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(target.release_id ?? ''), 'invalid candidate identity')
  assert(target.release_id !== priorIdentity.RELEASE_ID && target.git_sha !== prior.services.ui.git_sha, 'candidate must identify a new UI release')
  assert(images?.schema_version === 1 && images.build_scope === 'components' && images.release_id === target.release_id && images.release_git_sha === target.git_sha && images.source_sha256 === target.source_sha256, 'component build identity differs')
  for (const key of ['image_references', 'image_digests', 'image_metadata']) exactNames(images[key], ['merchant-ui'], key)
  const ref = images.image_references['merchant-ui'], metadata = images.image_metadata['merchant-ui']
  assert(immutable(ref) && images.image_digests['merchant-ui'] === ref.split('@')[1] && metadata.reference === ref && metadata.digest === ref.split('@')[1], 'UI immutable digest binding differs')
  const labels = { 'org.opencontainers.image.revision': target.git_sha, 'com.storenova.release.id': target.release_id, 'com.storenova.release.source_sha256': target.source_sha256 }
  assert(metadata.labels && Object.entries(labels).every(([key, value]) => metadata.labels[key] === value), 'UI build OCI labels differ')
  exactNames(imported, ['reference', 'image_id', 'repo_digests', 'labels', 'os', 'architecture'], 'imported UI projection')
  assert(imported.reference === ref && digest(imported.image_id) && Array.isArray(imported.repo_digests) && imported.repo_digests.includes(ref) && imported.os === 'linux' && imported.architecture === 'amd64' && Object.entries(labels).every(([key, value]) => imported.labels?.[key] === value), 'imported UI inspect evidence differs')
  assert(ref !== prior.services.ui.reference && imported.image_id !== prior.services.ui.image_id, 'UI image was not replaced')

  const candidate = structuredClone(original)
  candidate.services.ui.image = ref
  candidate.services.ui.labels = { ...candidate.services.ui.labels, ...labels }
  const records = Object.fromEntries(runtimeServices.map(name => {
    const current = baseline.runtime_services[name]
    return [name, { reference: name === 'ui' ? ref : current.reference, image_id: name === 'ui' ? imported.image_id : current.image_id, git_sha: name === 'ui' ? target.git_sha : current.git_sha, source_sha256: name === 'ui' ? target.source_sha256 : current.source_sha256, updated: recreated.includes(name), image_updated: name === 'ui' }]
  }))
  const setDigest = imageSetDigest(records)
  const manifest = {
    schema_version: 'demo-runtime-service-set/1', release_id: target.release_id,
    candidate_git_sha: target.git_sha, candidate_source_sha256: target.source_sha256,
    compose_project: project, release_scope: 'demo-merchant-ui-mixed-components',
    identity_semantics: 'candidate_git_sha identifies this publication bundle; services.*.git_sha identifies each immutable image',
    services: records, image_set_digest: setDigest,
    configuration_contract_sha256: sha(canonicalJson(stripIdentity(candidate))),
    migration_version: 270, migration_chain_sha256: prior.migration_chain_sha256,
    updated_services: recreated, image_updated_services: ['ui'], metadata_recreated_services: ['api', 'api-replica'],
    preserved_services: runtimeServices.filter(name => !recreated.includes(name)),
    compatibility_only_declared_service: 'migrate (never started; explicit up --no-deps)',
    rollback_policy: 'same-270 exact prior Compose/identity; same explicit three services; never restore or delete live data',
    prior_manifest_sha256: priorIdentity.RELEASE_MANIFEST_SHA256,
  }
  const manifestText = document(manifest)
  const nextIdentity = { RELEASE_ID: target.release_id, RELEASE_GIT_SHA: target.git_sha, RELEASE_MANIFEST_SHA256: sha(manifestText), RELEASE_IMAGE_SET_DIGEST: setDigest }
  for (const name of ['api', 'api-replica']) Object.assign(candidate.services[name].environment, nextIdentity)
  // Independent minimal-change assertion: do not relabel old API/worker images.
  const restored = structuredClone(candidate)
  restored.services.ui.image = original.services.ui.image
  if (original.services.ui.labels === undefined) delete restored.services.ui.labels
  else restored.services.ui.labels = structuredClone(original.services.ui.labels)
  for (const name of ['api', 'api-replica']) for (const key of keys) restored.services[name].environment[key] = original.services[name].environment[key]
  assert(same(restored, original), 'unapproved Compose mutation')
  const composeText = document(candidate)
  const summary = { configuration_only: true, runtime_mutated: false, deploy_authorized: false, ...nextIdentity, updated_services: recreated, image_updated_services: ['ui'], preserved_services: manifest.preserved_services, baseline_container_ids: baselineIds, candidate_compose_sha256: sha(composeText), rollback_compose_sha256: sha(baseline.compose_text), rollback_manifest_sha256: sha(baseline.manifest_text), migration_version: 270, migration_chain_sha256: prior.migration_chain_sha256, required_next_checks: ['hold existing deployment lock', 'reinspect exact baseline CIDs, config, mounts, networks and public identity', 'verify source archive and real UI bytes/labels/digest', 'protected Compose render and no-interpolate review', 'same-three-service rollback review', 'explicit ui api api-replica update only', '15 healthy, 12 preserved CIDs, image IDs and full release tuple', 'desktop navigation and local stdio read verification'] }
  return { candidate_compose_text: composeText, manifest_text: manifestText, identity: nextIdentity, rollback_compose_text: baseline.compose_text, rollback_manifest_text: baseline.manifest_text, rollback_identity: structuredClone(priorIdentity), review: summary }
}

