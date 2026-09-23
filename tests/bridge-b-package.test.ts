import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = resolve('infra/scripts/verify-bridge-b-package.mjs')
const validator = resolve('infra/scripts/validate-ecs-compose-release.rb')
const oldGitSha = 'ec3d69e37809c0d622c8f38057a072245217004f'
const gitSha = 'b'.repeat(40)
const names: Record<string, string[]> = {
  'merchant-api': ['api', 'api-replica'],
  'merchant-worker': ['worker-sync', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-automation', 'worker-scan'],
  'merchant-ui': ['ui'],
  'merchant-ops-ui': ['ops-ui'],
  'payment-gateway': ['payment-gateway'],
  'pilot-gateway': ['pilot-gateway'],
  'postgres-migration': ['migrate'],
  clamav: ['clamav'],
}
const owned = Object.keys(names).filter(name => name !== 'postgres-migration' && name !== 'clamav')
const digest = (character: string) => `sha256:${character.repeat(64)}`
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-b-package-'))
  const path = (name: string) => join(dir, name)
  const refs: Record<string, string> = {}
  const digests: Record<string, string> = {}
  for (const [index, artifact] of Object.keys(names).entries()) {
    digests[artifact] = digest('12345678'[index]!)
    refs[artifact] = artifact === 'postgres-migration'
      ? `registry.example.com/library/postgres:17-alpine@${digests[artifact]}`
      : `registry.example.com/${artifact}@${digests[artifact]}`
  }
  const source = path('source.tar')
  writeFileSync(source, 'fixture-only-not-an-archive')
  const sourceSha = `sha256:${sha(readFileSync(source))}`
  const identity = path('identity.txt')
  writeFileSync(identity, `schema_version=candidate-identity/2\nrelease_id=release-bridge-b\ngit_sha=${gitSha}\nsource_sha256=${sourceSha}\nplugin_darwin_descriptor_sha256=${digest('a')}\nplugin_darwin_test_sha256=${digest('b')}\nplugin_win32_descriptor_sha256=${digest('c')}\nplugin_win32_test_sha256=${digest('d')}\nplugin_key_id=plugin-test-key\n`)
  const releaseImages = path('release-images.json')
  writeFileSync(releaseImages, JSON.stringify({ schema_version: 1, release_id: 'release-bridge-b', release_git_sha: gitSha, source_sha256: sourceSha, image_digests: Object.fromEntries(owned.map(name => [name, digests[name]])), image_references: Object.fromEntries(owned.map(name => [name, refs[name]])) }))
  const eightImages = path('eight-image-set.json')
  writeFileSync(eightImages, JSON.stringify({ schema_version: 1, release_id: 'release-bridge-b', release_git_sha: gitSha, source_sha256: sourceSha, image_digests: digests, image_references: refs }))
  function compose(releaseId: string, releaseGit: string, bridge: boolean) {
    const services: Record<string, { image: string; environment?: Record<string, string> }> = {}
    for (const [artifact, serviceNames] of Object.entries(names)) {
      for (const serviceName of serviceNames) {
        const service: { image: string; environment?: Record<string, string> } = { image: refs[artifact]! }
        if (bridge && (serviceName === 'api' || serviceName === 'api-replica' || serviceName.startsWith('worker-'))) service.environment = { BRIDGE_SCHEMA_COMPATIBILITY_MODE: 'prefix_242_or_244' }
        if (serviceName === 'api' || serviceName === 'api-replica') service.environment = { ...service.environment, RELEASE_ID: releaseId, RELEASE_GIT_SHA: releaseGit, RELEASE_MANIFEST_SHA256: '', RELEASE_IMAGE_SET_DIGEST: '' }
        services[serviceName] = service
      }
    }
    const doc = { services }
    const file = path(`${releaseId}.json`)
    writeFileSync(file, JSON.stringify(doc))
    const manifest = execFileSync('ruby', [validator, file, JSON.stringify(digests), '--print-manifest-sha256'], { encoding: 'utf8' }).trim()
    const imageSet = execFileSync('ruby', [validator, file, JSON.stringify(digests), '--print-image-set-digest'], { encoding: 'utf8' }).trim()
    for (const serviceName of ['api', 'api-replica']) {
      services[serviceName]!.environment!.RELEASE_MANIFEST_SHA256 = manifest
      services[serviceName]!.environment!.RELEASE_IMAGE_SET_DIGEST = imageSet
    }
    writeFileSync(file, JSON.stringify(doc))
    return { file, manifest, imageSet }
  }
  const current = compose('release-bridge-b', gitSha, true)
  const previous = compose('release-old', oldGitSha, false)
  const rollbackEnv = path('rollback.env')
  writeFileSync(rollbackEnv, 'FIXTURE_ONLY=true\n')
  const rollbackDigests = path('rollback-digests.json')
  writeFileSync(rollbackDigests, JSON.stringify(digests))
  const rollbackPlan = path('rollback-plan.json')
  const now = Date.now()
  const plan = {
    schema_version: '1', kind: 'ecs-compose-rollback-capsule', created_at: new Date(now - 60_000).toISOString(), expires_at: new Date(now + 3_600_000).toISOString(), compose_project: 'merchant-production',
    current: { release_id: 'release-bridge-b', git_sha: gitSha, manifest_sha256: current.manifest, image_set_digest: current.imageSet },
    target: { release_id: 'release-old', git_sha: oldGitSha, manifest_sha256: previous.manifest, image_set_digest: previous.imageSet, compose_sha256: sha(readFileSync(previous.file)), env_sha256: sha(readFileSync(rollbackEnv)), image_digests_sha256: sha(readFileSync(rollbackDigests)) },
    database: { strategy: 'forward_only', schema_downgrade: false, live_migration_version: 242, target_migration_tail: 242 }, volumes: { preserve: true },
  }
  const writePlan = () => writeFileSync(rollbackPlan, JSON.stringify(plan))
  writePlan()
  const argumentsList = ['--candidate-identity', identity, '--source-archive', source, '--release-images', releaseImages, '--eight-image-set', eightImages, '--rendered-compose', current.file, '--rollback-plan', rollbackPlan, '--rollback-compose', previous.file, '--rollback-env', rollbackEnv, '--rollback-image-digests-json', rollbackDigests]
  const run = () => execFileSync('node', [script, ...argumentsList], { encoding: 'utf8', stdio: 'pipe' })
  return { run, plan, writePlan, identity, source, current }
}

describe('bridge B code-only package gate', () => {
  it('accepts an internally bound B package with a 242 rollback capsule', () => {
    const item = fixture()
    expect(JSON.parse(item.run()).status).toBe('bridge-b-package-verified')
  })
  it('rejects a cutover capsule that assumes migration 244 has already run', () => {
    const item = fixture()
    item.plan.database.live_migration_version = 244
    item.writePlan()
    expect(item.run).toThrow()
  })
  it('rejects a source archive changed after identity creation', () => {
    const item = fixture()
    writeFileSync(item.source, 'tampered')
    expect(item.run).toThrow()
  })
  it('rejects a legacy identity without the separate signed local plugin contract', () => {
    const item = fixture()
    writeFileSync(item.identity, readFileSync(item.identity, 'utf8').replace('schema_version=candidate-identity/2\n', ''))
    expect(item.run).toThrow()
  })
  it('rejects a bridge Compose missing one worker compatibility mode', () => {
    const item = fixture()
    const doc = JSON.parse(readFileSync(item.current.file, 'utf8'))
    delete doc.services['worker-scan'].environment.BRIDGE_SCHEMA_COMPATIBILITY_MODE
    writeFileSync(item.current.file, JSON.stringify(doc))
    expect(item.run).toThrow()
  })
})
