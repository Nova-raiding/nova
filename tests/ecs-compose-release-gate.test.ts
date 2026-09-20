import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  declaredProducers,
  envTemplateKeys,
  preflightAssertions,
  productionLayerPaths,
  requiredProductionVariables,
} from './invariants/release-env-closure.js'

const digest = (character: string) => `sha256:${character.repeat(64)}`
const digests = {
  'merchant-api': digest('a'),
  'merchant-worker': digest('b'),
  'merchant-ui': digest('c'),
  'merchant-ops-ui': digest('d'),
  'payment-gateway': digest('e'),
  'pilot-gateway': digest('1'),
  clamav: digest('f'),
  'postgres-migration': digest('0'),
}
const groups: Record<string, string[]> = {
  'merchant-api': ['api', 'api-replica'],
  'postgres-migration': ['migrate'],
  'merchant-worker': ['worker-sync', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-automation', 'worker-scan'],
  'merchant-ui': ['ui'],
  'merchant-ops-ui': ['ops-ui'],
  'payment-gateway': ['payment-gateway'],
  'pilot-gateway': ['pilot-gateway'],
  clamav: ['clamav'],
}

function fixture() {
  const services: Record<string, unknown> = {}
  for (const [artifact, names] of Object.entries(groups)) {
    for (const name of names) services[name] = {
      image: artifact === 'postgres-migration'
        ? `registry.example.com/library/postgres:17-alpine@${digests[artifact as keyof typeof digests]}`
        : `registry.example.com/${artifact}@${digests[artifact as keyof typeof digests]}`,
    }
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

/**
 * The release layer is the only Compose layer that pins release artifacts to
 * immutable images, and `validate-ecs-compose-release.rb` refuses to release
 * unless every artifact in its `required` map carries the matching digest. Both
 * are consumer-side fixed lists. The producer side is the operator contract: a
 * `:?` assertion in a repository script (the ECS preflights) or a declaration in
 * `.env.example`, which the renderer reads through `--env-file .env`.
 *
 * `pilot-gateway` broke that closure. The service was pinned in the release layer
 * and added to the digest manifest, but `grep -rn PILOT_GATEWAY_IMAGE_REF` over
 * the whole repository returned exactly one line — the consumer. An operator who
 * supplied every variable the runbooks and the preflight named still stopped at
 * `error while interpolating services.pilot-gateway.image: required variable
 * PILOT_GATEWAY_IMAGE_REF is missing a value` (`docker compose ... config` exits
 * non-zero), and the pinned migration image had no producer for the same reason.
 * Docker Compose stops after 91 interpolation errors, so the release layer's own
 * failures stayed hidden behind the base layer's.
 *
 * This gate closes the loop in both directions: every service the digest manifest
 * requires must be pinned in the release layer, and every pinned variable must be
 * declared somewhere an operator can find it.
 */
const releaseLayerPath = 'infra/local/docker-compose.ecs-pilot-release.yml'

/** Service -> pinned image variable, following the `&anchor` / `<<: *anchor` shorthand. */
function releaseLayerPinnedImages(): Map<string, string> {
  const services: { name: string; varName?: string; anchorName?: string; anchorRef?: string }[] = []
  let current: (typeof services)[number] | undefined
  for (const line of readFileSync(releaseLayerPath, 'utf8').split('\n')) {
    const service = /^ {2}([a-z0-9][a-z0-9-]*):(?: &([A-Za-z0-9_-]+))?$/.exec(line)
    if (service) {
      current = { name: service[1]!, anchorName: service[2] }
      services.push(current)
      continue
    }
    const image = /^ {4}image: \$\{([A-Z0-9_]+):\?/.exec(line)
    if (image && current) {
      current.varName = image[1]
      continue
    }
    const anchor = /^ {4}<<: \*([A-Za-z0-9_-]+)$/.exec(line)
    if (anchor && current) current.anchorRef = anchor[1]
  }
  // The anchored mapping (not the service name) is what `<<:` names, so resolve
  // through the anchor table — `worker-generation` inherits `WORKER_IMAGE_REF`
  // from the `&release-worker-image` anchor declared on `worker-sync`.
  const anchored = new Map(services.filter(service => service.anchorName && service.varName).map(service => [service.anchorName!, service.varName!]))
  return new Map(services.map(service => [service.name, service.varName ?? anchored.get(service.anchorRef ?? '') ?? '']))
}

/** Every variable the release layer refuses to interpolate without (`${VAR:?}`). */
function releaseLayerRequiredVariables(): string[] {
  return [...new Set([...readFileSync(releaseLayerPath, 'utf8').matchAll(/\$\{([A-Z0-9_]+):\?/gu)].map(match => match[1]!))]
}


/** Artifact -> services, from the digest manifest the release gate enforces. */
function requiredReleaseArtifacts(): Map<string, string[]> {
  const source = readFileSync('infra/scripts/validate-ecs-compose-release.rb', 'utf8')
  const body = /required = \{(?<body>[\s\S]*?)\n\}/u.exec(source)?.groups?.body ?? ''
  return new Map([...body.matchAll(/'([a-z0-9-]+)' => %w\[([a-z0-9 -]+)\]/gu)].map(match => [match[1]!, match[2]!.split(' ')]))
}

/**
 * NOTE ON LAYERING. `declaredProducers()` lives in
 * `tests/invariants/release-env-closure.ts`, not here, so this gate and the
 * invariant evidence in `tests/release-env-closure.invariant.test.ts` share one
 * definition of "closed" instead of two that can drift. Its doc comment carries
 * the false-green history this gate shipped with: deleting the preflight half of
 * the `PILOT_GATEWAY_IMAGE_REF`/`MIGRATION_IMAGE_REF` fix left all six tests in
 * this file green, because a bare `.env.example` key counted as a producer.
 */

describe('ECS Compose release gate', () => {
  it('accepts only a complete immutable image set, including both gateways', () => {
    expect(run(fixture())).toMatch(/^sha256:[0-9a-f]{64}$/)
    const { ['payment-gateway']: _, ...missingPayment } = digests
    expect(() => run(fixture(), missingPayment)).toThrow(/payment-gateway digest/)
    // The public pilot gateway was the one service in the release layer that
    // still carried a `build:` directive instead of a pinned `image:`, so the
    // deploy and rollback paths (`up -d --no-build`) could not start it at all.
    // It must be pinned like every other artifact, and a missing digest must
    // fail closed rather than silently ship an unpinned public entry point.
    const { ['pilot-gateway']: __, ...missingPilot } = digests
    expect(() => run(fixture(), missingPilot)).toThrow(/pilot-gateway digest/)
  })

  it('requires migrate to use its own immutable PostgreSQL 17 image', () => {
    const apiBackedMigration = fixture() as any
    apiBackedMigration.services.migrate.image = apiBackedMigration.services.api.image
    expect(() => run(apiBackedMigration)).toThrow(/migrate image must be an immutable PostgreSQL 17/)

    const taggedMigration = fixture() as any
    taggedMigration.services.migrate.image = 'postgres:17-alpine'
    expect(() => run(taggedMigration)).toThrow(/migrate image must be an immutable/)

    const wrongMajorMigration = fixture() as any
    wrongMajorMigration.services.migrate.image = `registry.example.com/library/postgres:16-alpine@${digests['postgres-migration']}`
    expect(() => run(wrongMajorMigration)).toThrow(/PostgreSQL 17/)
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

  it('closes the fixed release manifest: every required variable has a producer, every required artifact is pinned', () => {
    const pinned = releaseLayerPinnedImages()
    const required = requiredReleaseArtifacts()
    // Non-vacuity: both halves of the closure must actually be parsed. A missing
    // artifact is caught by the digest test above, a missing pinned image by the
    // per-service assertion below.
    expect(required.size).toBeGreaterThan(0)
    expect(pinned.size).toBeGreaterThan(0)

    const unpinned = [...required].flatMap(([artifact, services]) =>
      services.filter(service => !pinned.get(service)).map(service => `${artifact} -> ${service}`))
    expect(unpinned, `these artifacts are in the digest manifest but are not pinned in ${releaseLayerPath}: add an \`image: \${VAR:?}\` line for each service and declare VAR (see the check below): ${unpinned.join(', ')}`).toEqual([])

    const requiredVariables = releaseLayerRequiredVariables()
    expect(requiredVariables.length).toBeGreaterThan(0)
    const declared = declaredProducers()
    const undeclared = requiredVariables.filter(name => !declared.has(name))
    expect(undeclared, `these variables are required by ${releaseLayerPath} but have no producer: declare each as ": "\${NAME:?NAME is required}"" in an infra/scripts preflight and list it in .env.example, so the deploy-time .env template and the preflight contract name it before the render fails: ${undeclared.join(', ')}`).toEqual([])
  })

  it('closes the whole production chain: every `:?` variable in every layer has both producers', () => {
    // The release layer is rendered last. The base layers are interpolated
    // first, so a variable nobody declared fails there — with the release
    // layer's own missing values hidden behind Compose's error cap.
    const required = requiredProductionVariables()
    // Non-vacuity: the chain really is being scanned, and it reaches past the
    // release layer whose closure the test above already covers on its own.
    expect(productionLayerPaths.length).toBeGreaterThanOrEqual(2)
    expect(productionLayerPaths).toContain(releaseLayerPath)
    expect(required.size).toBeGreaterThan(releaseLayerRequiredVariables().length)

    const inTemplate = envTemplateKeys()
    const inPreflight = preflightAssertions()
    const names = [...required.keys()].sort()
    const missingFromTemplate = names.filter(name => !inTemplate.has(name))
    expect(missingFromTemplate, `these variables are required by the production Compose chain but .env.example never declares them, so an operator building the ECS host .env from the repository's only template cannot supply them: ${missingFromTemplate.join(', ')}`).toEqual([])
    const missingFromPreflight = names.filter(name => !inPreflight.has(name))
    expect(missingFromPreflight, `these variables are required by the production Compose chain but no infra/scripts/*.sh preflight refuses to run without them, so the render fails before anything names the missing key (Compose truncates its interpolation errors): add ": "\${NAME:?NAME is required}"" to the ECS preflight for each: ${missingFromPreflight.join(', ')}`).toEqual([])
  })

  it('keeps the two producer halves genuinely distinct, so their intersection is not a union in disguise', () => {
    // `declaredProducers()` is the intersection of the template keys and the
    // preflight assertions. If either half were a superset of the other — or if
    // a helper silently fell back to one of them — the intersection would stop
    // being stricter than the halves and the closure above would go vacuously
    // green, which is exactly the failure the preflight half was missing.
    const inTemplate = envTemplateKeys()
    const inPreflight = preflightAssertions()
    const templateOnly = [...inTemplate].filter(name => !inPreflight.has(name))
    const preflightOnly = [...inPreflight].filter(name => !inTemplate.has(name))
    expect(templateOnly.length, 'a `.env.example` key no preflight asserts is expected (local-only settings), but there must be at least one for the two halves to differ').toBeGreaterThan(0)
    expect(preflightOnly.length, 'a preflight assertion with no `.env.example` key is expected (release-pipeline values), but there must be at least one for the two halves to differ').toBeGreaterThan(0)
    const declared = declaredProducers()
    expect(declared.size).toBeLessThan(inTemplate.size)
    expect(declared.size).toBeLessThan(inPreflight.size)
  })
})
