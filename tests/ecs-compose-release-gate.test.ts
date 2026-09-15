import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const digest = (character: string) => `sha256:${character.repeat(64)}`
const digests = {
  'merchant-api': digest('a'),
  'merchant-worker': digest('b'),
  'merchant-ui': digest('c'),
  'merchant-ops-ui': digest('d'),
  'payment-gateway': digest('e'),
  clamav: digest('f'),
}
const groups: Record<string, string[]> = {
  'merchant-api': ['api', 'api-replica', 'migrate'],
  'merchant-worker': ['worker-sync', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-automation', 'worker-scan'],
  'merchant-ui': ['ui'],
  'merchant-ops-ui': ['ops-ui'],
  'payment-gateway': ['payment-gateway'],
  clamav: ['clamav'],
}

function fixture() {
  const services: Record<string, unknown> = {}
  for (const [artifact, names] of Object.entries(groups)) {
    for (const name of names) services[name] = { image: `registry.example.com/${artifact}@${digests[artifact as keyof typeof digests]}` }
  }
  return { services }
}

function run(document: unknown, digestSet: Record<string, string> = digests) {
  const directory = mkdtempSync(join(tmpdir(), 'ecs-compose-release-'))
  const path = join(directory, 'compose.json')
  writeFileSync(path, JSON.stringify(document))
  return execFileSync('ruby', ['infra/scripts/validate-ecs-compose-release.rb', path, JSON.stringify(digestSet), '--print-image-set-digest'], { encoding: 'utf8' }).trim()
}

function runContract(document: unknown, env: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), 'ecs-compose-contract-'))
  const path = join(directory, 'compose.json')
  writeFileSync(path, JSON.stringify(document))
  return execFileSync('ruby', ['infra/scripts/validate-ecs-compose-release.rb', path, JSON.stringify(digests)], { encoding: 'utf8', env: { ...process.env, ...env } })
}

describe('ECS Compose release gate', () => {
  it('accepts only a complete immutable image set, including payment gateway', () => {
    expect(run(fixture())).toMatch(/^sha256:[0-9a-f]{64}$/)
    const { ['payment-gateway']: _, ...missingPayment } = digests
    expect(() => run(fixture(), missingPayment)).toThrow(/payment-gateway digest/)
  })

  it('rejects tag images and build directives', () => {
    const tagged = fixture() as any
    tagged.services.api.image = 'registry.example.com/merchant-api:latest'
    expect(() => run(tagged)).toThrow(/api image must be an immutable/)
    const built = fixture() as any
    built.services['worker-sync'].build = { context: '.' }
    expect(() => run(built)).toThrow(/worker-sync must not contain a build directive/)
  })

  it('rejects a missing required workload', () => {
    const document = fixture() as any
    delete document.services['worker-scan']
    expect(() => run(document)).toThrow(/required ECS service is missing: worker-scan/)
  })

  it('binds API runtime release metadata to the normalized Compose contract', () => {
    const document = fixture() as any
    for (const name of ['api', 'api-replica']) document.services[name].environment = {}
    const directory = mkdtempSync(join(tmpdir(), 'ecs-compose-hash-'))
    const path = join(directory, 'compose.json')
    writeFileSync(path, JSON.stringify(document))
    const manifest = execFileSync('ruby', ['infra/scripts/validate-ecs-compose-release.rb', path, JSON.stringify(digests), '--print-manifest-sha256'], { encoding: 'utf8' }).trim()
    const imageSet = run(document)
    for (const name of ['api', 'api-replica']) Object.assign(document.services[name].environment, {
      RELEASE_ID: 'release-1', RELEASE_GIT_SHA: 'a'.repeat(40), RELEASE_MANIFEST_SHA256: manifest, RELEASE_IMAGE_SET_DIGEST: imageSet,
    })
    expect(runContract(document, { RELEASE_ID: 'release-1', RELEASE_GIT_SHA: 'a'.repeat(40) })).toContain('ECS Compose release gate passed')
    document.services.api.environment.RELEASE_ID = 'different-release'
    expect(() => runContract(document, { RELEASE_ID: 'release-1', RELEASE_GIT_SHA: 'a'.repeat(40) })).toThrow(/api RELEASE_ID does not match/)
  })
})
