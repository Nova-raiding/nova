import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadMigrations, migrationChecksum } from '../packages/persistence/src/migration.js'

const moduleUrl = pathToFileURL(resolve('infra/scripts/prepare-ecs-demo-component-update.mjs')).href
const { prepareDemoComponentUpdate: prepare, imageSetDigest, canonicalJson, runtimeServices } = await import(moduleUrl)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const sha = (value: string) => `sha256:${hash(value)}`
const previousGit = 'a'.repeat(40), nextGit = 'b'.repeat(40)
const previousSource = sha('previous source'), nextSource = sha('next source')
const keys = ['RELEASE_ID', 'RELEASE_GIT_SHA', 'RELEASE_MANIFEST_SHA256', 'RELEASE_IMAGE_SET_DIGEST']

// Synthetic evidence only; these fixtures make no claim about live Docker.
function fixture() {
  const services: Record<string, any> = {}, records: Record<string, any> = {}, actual: Record<string, any> = {}
  for (const name of runtimeServices as string[]) {
    const upstream = ['postgres', 'redis', 'clamav'].includes(name)
    const reference = ['postgres', 'redis'].includes(name) ? `${name}:reviewed-tag` : `registry.example/${name}@${sha(name)}`
    services[name] = { image: reference, environment: { UNCHANGED_PRIVATE_VALUE: 'fixture-only' }, labels: { 'org.opencontainers.image.revision': previousGit }, healthcheck: { test: ['CMD-SHELL', 'test "$${ROLE}" = ready'], interval: '10s' }, networks: { default: {} }, volumes: [] }
    records[name] = { reference, image_id: sha(`${name} image`), git_sha: upstream ? null : previousGit, updated: false }
    actual[name] = { container_id: hash(`${name} CID`), reference, image_id: records[name].image_id, git_sha: records[name].git_sha, source_sha256: upstream ? null : previousSource, running: true, health: 'healthy', restarts: 0, oom_killed: false, compose_service_sha256: '' }
  }
  services.migrate = { image: 'postgres:reviewed-tag', command: ['never-start-migrate'] }
  const compose = { services, networks: { default: { name: 'preserved_private' } }, volumes: { data: { name: 'existing_business_data' } } }
  for (const name of ['api', 'api-replica']) Object.assign(services[name].environment, { MCP_INTEGRATION_MODE: 'local_stdio', OPS_AUTH_MODE: 'password', RUN_MIGRATIONS_ON_STARTUP: 'false' })
  const migrations = Array.from({ length: 270 }, (_, i) => ({ version: i + 1, name: `fixture_${i + 1}`, checksum: hash(`migration${i}`) }))
  const manifest = { schema_version: 'demo-runtime-service-set/1', release_id: 'release-previous', candidate_git_sha: previousGit, compose_project: 'merchant-demo-85575f9c', services: records, image_set_digest: imageSetDigest(records), configuration_contract_sha256: hash(canonicalJson(compose)), migration_version: 270, migration_chain_sha256: hash(canonicalJson(migrations)) }
  const manifestText = JSON.stringify(manifest, null, 2) + '\n'
  const identity = { RELEASE_ID: manifest.release_id, RELEASE_GIT_SHA: previousGit, RELEASE_MANIFEST_SHA256: hash(manifestText), RELEASE_IMAGE_SET_DIGEST: manifest.image_set_digest }
  for (const name of ['api', 'api-replica']) Object.assign(services[name].environment, identity)
  for (const name of runtimeServices as string[]) actual[name].compose_service_sha256 = hash(canonicalJson(services[name]))
  const reference = `registry.example/merchant-ui@${sha('new UI digest')}`
  const labels = { 'org.opencontainers.image.revision': nextGit, 'com.storenova.release.id': 'release-next', 'com.storenova.release.source_sha256': nextSource }
  return {
    schema_version: 'demo-component-update-input/1', compose_project: 'merchant-demo-85575f9c',
    baseline: { compose_text: JSON.stringify(compose, null, 4) + '\n', manifest_text: manifestText, identity, public_identity: structuredClone(identity), runtime_services: actual, migrations },
    target_migrations: structuredClone(migrations), candidate: { release_id: 'release-next', git_sha: nextGit, source_sha256: nextSource },
    component_images: { schema_version: 1, build_scope: 'components', release_id: 'release-next', release_git_sha: nextGit, source_sha256: nextSource, image_references: { 'merchant-ui': reference }, image_digests: { 'merchant-ui': reference.split('@')[1] }, image_metadata: { 'merchant-ui': { reference, digest: reference.split('@')[1], labels } } },
    imported_ui: { reference, image_id: sha('new UI image'), repo_digests: [reference], labels, os: 'linux', architecture: 'amd64' },
  }
}
function reseal(input: ReturnType<typeof fixture>, mutate: (compose: any, manifest: any) => void) {
  const compose = JSON.parse(input.baseline.compose_text), manifest = JSON.parse(input.baseline.manifest_text)
  mutate(compose, manifest)
  const contract = structuredClone(compose)
  for (const service of Object.values(contract.services) as any[]) for (const key of keys) delete service.environment?.[key]
  manifest.configuration_contract_sha256 = hash(canonicalJson(contract))
  manifest.image_set_digest = imageSetDigest(manifest.services)
  input.baseline.manifest_text = JSON.stringify(manifest) + '\n'
  Object.assign(input.baseline.identity, { RELEASE_MANIFEST_SHA256: hash(input.baseline.manifest_text), RELEASE_IMAGE_SET_DIGEST: manifest.image_set_digest })
  input.baseline.public_identity = structuredClone(input.baseline.identity)
  for (const name of ['api', 'api-replica']) Object.assign(compose.services[name].environment, input.baseline.identity)
  input.baseline.compose_text = JSON.stringify(compose) + '\n'
  for (const name of runtimeServices as string[]) input.baseline.runtime_services[name].compose_service_sha256 = hash(canonicalJson(compose.services[name]))
}

describe('Demo UI mixed-component publication identity', () => {
  it('matches the existing Python canonical JSON ASCII byte contract', () => {
    expect(canonicalJson({ z: '中😀\u007f', a: ['value', true, null, 270] })).toBe('{"a":["value",true,null,270],"z":"\\u4e2d\\ud83d\\ude00\\u007f"}')
  })
  it('changes one image, recreates three services, and preserves each old image identity and exact rollback bytes', () => {
    const input = fixture(), before = structuredClone(input), result = prepare(input)
    const candidate = JSON.parse(result.candidate_compose_text), original = JSON.parse(input.baseline.compose_text), manifest = JSON.parse(result.manifest_text)
    expect(input).toEqual(before)
    expect(result.rollback_compose_text).toBe(input.baseline.compose_text)
    expect(result.rollback_manifest_text).toBe(input.baseline.manifest_text)
    expect(result.rollback_identity).toEqual(input.baseline.identity)
    expect(result.review.updated_services).toEqual(['api', 'api-replica', 'ui'])
    expect(result.review.preserved_services).toHaveLength(12)
    expect(Object.keys(manifest.services)).toHaveLength(15)
    expect(manifest.services.ui.git_sha).toBe(nextGit)
    expect(manifest.services.api.git_sha).toBe(previousGit)
    expect(manifest.services.api.image_updated).toBe(false)
    expect(manifest.services['worker-generation'].source_sha256).toBe(previousSource)
    for (const name of runtimeServices as string[]) {
      if (name === 'ui') continue
      expect(candidate.services[name].image).toBe(original.services[name].image)
      expect(candidate.services[name].labels).toEqual(original.services[name].labels)
      expect(candidate.services[name].healthcheck).toEqual(original.services[name].healthcheck)
      if (!['api', 'api-replica'].includes(name)) expect(candidate.services[name]).toEqual(original.services[name])
    }
    expect(candidate.services.migrate).toEqual(original.services.migrate)
    expect(candidate.volumes).toEqual(original.volumes)
    expect(candidate.networks).toEqual(original.networks)
    for (const name of ['api', 'api-replica']) for (const key of keys) expect(candidate.services[name].environment[key]).toBe(result.identity[key])
    expect(result.identity.RELEASE_MANIFEST_SHA256).toBe(hash(result.manifest_text))
    expect(result.identity.RELEASE_IMAGE_SET_DIGEST).toBe(imageSetDigest(manifest.services))
    const stripped = structuredClone(candidate)
    for (const service of Object.values(stripped.services) as any[]) for (const key of keys) delete service.environment?.[key]
    expect(manifest.configuration_contract_sha256).toBe(hash(canonicalJson(stripped)))
    expect(result.review.deploy_authorized).toBe(false)
  })

  it('is deterministic despite input record insertion order', () => {
    const input = fixture(), reversed = structuredClone(input)
    reversed.baseline.runtime_services = Object.fromEntries(Object.entries(reversed.baseline.runtime_services).reverse())
    expect(prepare(reversed)).toEqual(prepare(input))
  })

  it.each([
    ['public tuple drift', (x: any) => { x.baseline.public_identity.RELEASE_ID = 'release-drift' }],
    ['manifest bytes drift', (x: any) => { x.baseline.manifest_text += ' ' }],
    ['Compose drift', (x: any) => { const c = JSON.parse(x.baseline.compose_text); c.networks.default.name = 'drift'; x.baseline.compose_text = JSON.stringify(c) }],
    ['missing runtime service', (x: any) => { delete x.baseline.runtime_services['worker-scan'] }],
    ['unexpected runtime service', (x: any) => { x.baseline.runtime_services.shadow = x.baseline.runtime_services.api }],
    ['actual image mismatch', (x: any) => { x.baseline.runtime_services.api.image_id = sha('other') }],
    ['actual configuration mismatch', (x: any) => { x.baseline.runtime_services.api.compose_service_sha256 = hash('other') }],
    ['unhealthy service', (x: any) => { x.baseline.runtime_services.redis.health = 'unhealthy' }],
    ['restart regression', (x: any) => { x.baseline.runtime_services.api.restarts = 1 }],
    ['bool restart', (x: any) => { x.baseline.runtime_services.api.restarts = false }],
    ['raw environment projection', (x: any) => { x.baseline.runtime_services.api.Env = ['SECRET=fixture'] }],
    ['duplicate CID', (x: any) => { x.baseline.runtime_services.ui.container_id = x.baseline.runtime_services.api.container_id }],
    ['migration checksum drift', (x: any) => { x.target_migrations[269].checksum = hash('other') }],
    ['migration count drift', (x: any) => { x.target_migrations.pop() }],
    ['wrong candidate source', (x: any) => { x.candidate.source_sha256 = sha('other') }],
    ['extra built component', (x: any) => { x.component_images.image_references['merchant-api'] = x.imported_ui.reference }],
    ['mutable UI reference', (x: any) => { x.component_images.image_references['merchant-ui'] = 'registry.example/ui:latest' }],
    ['local digest not imported', (x: any) => { x.imported_ui.repo_digests = [] }],
    ['OCI label drift', (x: any) => { x.imported_ui.labels['org.opencontainers.image.revision'] = previousGit }],
    ['wrong target platform', (x: any) => { x.imported_ui.architecture = 'arm64' }],
    ['production project', (x: any) => { x.compose_project = 'production' }],
  ])('rejects %s', (_label, mutate) => {
    const input = fixture(); mutate(input); expect(() => prepare(input)).toThrow()
  })

  it('rejects startup DDL even when the caller seals a consistent baseline', () => {
    const input = fixture()
    reseal(input, compose => { compose.services.api.environment.RUN_MIGRATIONS_ON_STARTUP = 'true' })
    expect(() => prepare(input)).toThrow(/security\/no-DDL/)
  })
  it('retains unrelated old component revisions rather than relabeling the complete bundle', () => {
    const input = fixture(), olderGit = 'c'.repeat(40)
    input.baseline.runtime_services['payment-gateway'].git_sha = olderGit
    reseal(input, (_compose, manifest) => { manifest.services['payment-gateway'].git_sha = olderGit })
    expect(JSON.parse(prepare(input).manifest_text).services['payment-gateway'].git_sha).toBe(olderGit)
  })
  it('retains the actual host-owned pilot gateway pinned by its exact config image ID', () => {
    const input = fixture(), current = input.baseline.runtime_services['pilot-gateway']
    current.reference = current.image_id
    reseal(input, (compose, manifest) => {
      compose.services['pilot-gateway'].image = current.image_id
      manifest.services['pilot-gateway'].reference = current.image_id
      manifest.services['pilot-gateway'].source_sha256 = null
    })
    const result = prepare(input), record = JSON.parse(result.manifest_text).services['pilot-gateway']
    expect(record.reference).toBe(current.image_id)
    expect(record.image_id).toBe(current.image_id)
    expect(record.git_sha).toBe(previousGit)
    expect(record.source_sha256).toBe(previousSource)
    expect(record.updated).toBe(false)
    expect(result.review.preserved_services).toContain('pilot-gateway')
  })
  it.each(['pilot-gateway', 'api', 'payment-gateway'])('rejects invalid config-ID-only references for %s', name => {
    const input = fixture(), current = input.baseline.runtime_services[name]
    current.reference = name === 'pilot-gateway' ? sha('different config ID') : current.image_id
    reseal(input, (compose, manifest) => {
      compose.services[name].image = current.reference
      manifest.services[name].reference = current.reference
    })
    expect(() => prepare(input)).toThrow(/owned image metadata incomplete/)
  })
  it('requires actual owned image source metadata when the old manifest omits source SHA', () => {
    const input = fixture()
    expect(JSON.parse(input.baseline.manifest_text).services.api.source_sha256).toBeUndefined()
    input.baseline.runtime_services.api.source_sha256 = null
    expect(() => prepare(input)).toThrow(/owned image metadata incomplete/)
  })
  it('rejects null pilot source even when historical manifest source is unknown', () => {
    const input = fixture(), current = input.baseline.runtime_services['pilot-gateway']
    current.reference = current.image_id; current.source_sha256 = null
    reseal(input, (compose, manifest) => {
      compose.services['pilot-gateway'].image = current.image_id
      Object.assign(manifest.services['pilot-gateway'], { reference: current.image_id, source_sha256: null })
    })
    expect(() => prepare(input)).toThrow(/owned image metadata incomplete/)
  })
  it('rejects source SHA drift when the old manifest already records it', () => {
    const input = fixture()
    reseal(input, (_compose, manifest) => { manifest.services.api.source_sha256 = sha('other source') })
    expect(() => prepare(input)).toThrow(/source digest differs/)
  })
  it('strictly reproduces the deployed 270-row migration chain with actual logical Migration.name values', async () => {
    const rows = (await loadMigrations()).map(migration => ({ version: migration.version, name: migration.name, checksum: migrationChecksum(migration.sql) }))
    expect(rows).toHaveLength(270)
    expect(rows[99]?.name).toBe('operation_alert_notifications')
    const chain = hash(canonicalJson(rows))
    expect(chain).toBe('35ce499eddb68b7a6233f7a86970d2b412ac540d04675b7fc84b79cf36bc38bf')
    const input = fixture()
    input.baseline.migrations = rows
    input.target_migrations = structuredClone(rows)
    reseal(input, (_compose, manifest) => { manifest.migration_chain_sha256 = chain })
    expect(JSON.parse(prepare(input).manifest_text).migration_chain_sha256).toBe(chain)
  })
  it.each(['100_operation_alert_notifications.sql', '../operation_alert_notifications', 'operation-alert-notifications'])('rejects invalid logical migration name %s', name => {
    const input = fixture()
    input.target_migrations[99]!.name = name
    expect(() => prepare(input)).toThrow(/migration version\/name\/checksum/)
  })
  it('rejects a pilot gateway without a real Git revision even when its config ID and source digest are exact', () => {
    const input = fixture(), current = input.baseline.runtime_services['pilot-gateway']
    current.reference = current.image_id; current.git_sha = null
    reseal(input, (compose, manifest) => {
      compose.services['pilot-gateway'].image = current.image_id
      Object.assign(manifest.services['pilot-gateway'], { reference: current.image_id, git_sha: null, source_sha256: previousSource })
    })
    expect(() => prepare(input)).toThrow(/owned image metadata incomplete/)
  })
  it('accepts legitimate non-ASCII baseline configuration without dropping its existing hash contract', () => {
    const input = fixture()
    reseal(input, compose => { compose.services.api.environment.UNCHANGED_PRIVATE_VALUE = '合法配置😀' })
    const result = prepare(input)
    expect(JSON.parse(result.candidate_compose_text).services.api.environment.UNCHANGED_PRIVATE_VALUE).toBe('合法配置😀')
    expect(result.rollback_compose_text).toBe(input.baseline.compose_text)
  })
})
