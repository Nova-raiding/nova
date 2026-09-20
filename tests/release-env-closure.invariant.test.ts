import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { declaredProducers, productionLayerPaths, requiredProductionVariables } from './invariants/release-env-closure.js'

/**
 * Invariant: every variable the production Compose chain refuses to interpolate
 * without (`${VAR:?}`) must have a producer an operator can find in the
 * repository — in *both* the deploy template and a preflight contract — and that
 * closure must cover every layer the renderer evaluates.
 *
 * Evidence for `credential-transport-and-release-env.invariant.ts`. This is a
 * real render: the ordered layer manifest, `docker compose config` over all of
 * it, and an env file containing exactly the variables the repository's
 * producers name. Nothing here asserts on source text and nothing is handed to
 * the renderer as a fixture — if the closure is incomplete, the shipped pipeline
 * exits non-zero and so does this test.
 *
 * The producer oracle is imported rather than re-implemented: `declaredProducers`
 * in `tests/invariants/release-env-closure.ts` is the one place that decides what
 * "declared" means, so this evidence cannot drift away from the gate it stands
 * behind.
 *
 * The regression this reproduces: deleting the preflight half for
 * `PILOT_GATEWAY_IMAGE_REF`/`MIGRATION_IMAGE_REF` while leaving `.env.example`
 * untouched left the closure gate green, because it counted a bare
 * `.env.example` key as a producer. Only a test that renders from the *declared*
 * producers — which, under the both-halves rule, no longer include the deleted
 * key — can tell the difference.
 */

/**
 * What an operator would put in `.env` for a key the repository tells them to
 * supply. The render only interpolates text, so any well-formed value works —
 * the failure under test is a *missing* declaration, never a malformed value
 * (which the preflights and validate-ecs-compose-release.rb reject separately).
 */
function suppliedValue(name: string): string {
  // Evidence paths are bind-mount sources in the pilot layers, so a relative
  // value would be read as a named volume and fail the project as a whole.
  if (name.endsWith('_ROOT')) return '/run/release-evidence'
  if (name.endsWith('_PATH')) return `/run/release-evidence/${name.toLowerCase().replace(/_path$/, '')}.json`
  if (name.endsWith('_IMAGE_REF')) return `registry.example.com/merchant/${name.toLowerCase().replace(/_image_ref$/, '')}@sha256:${'a'.repeat(64)}`
  if (name.endsWith('_GIT_SHA')) return 'd'.repeat(40)
  if (name.endsWith('_SHA256')) return 'b'.repeat(64)
  if (name.endsWith('IMAGE_SET_DIGEST')) return `sha256:${'c'.repeat(64)}`
  if (name.endsWith('_URL') || name.endsWith('_ENDPOINT')) return 'https://operator-supplied.example'
  if (name.endsWith('_DAYS') || name.endsWith('_BYTES') || name.endsWith('_MINUTES')) return '30'
  return `operator-supplied-${name.toLowerCase()}`
}

/** The real render pipeline: every layer, in order, through the Compose interpolation the deploy host runs. */
function renderProductionChain(env: Map<string, string>): { status: number; stderr: string } {
  const directory = mkdtempSync(join(tmpdir(), 'release-env-closure-'))
  const envFile = join(directory, 'operator.env')
  writeFileSync(envFile, [...env].map(([name, value]) => `${name}=${value}`).join('\n') + '\n')
  const result = spawnSync('docker', [
    'compose', '--env-file', envFile,
    ...productionLayerPaths.flatMap(layer => ['-f', layer]),
    'config', '--format', 'json',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    // A pristine environment: values must come from the operator's `.env`, not
    // from whatever the test runner happens to have exported.
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
  })
  if (result.error) throw new Error(`docker compose is required to render the production chain: ${result.error.message}`)
  return { status: result.status ?? -1, stderr: result.stderr ?? '' }
}

describe('the production Compose chain is renderable from the repository-declared variables', () => {
  it('names every `:?` variable of every layer in both producers', () => {
    const required = requiredProductionVariables()
    // Non-vacuity: the scan has to reach past the release layer, which the
    // first version of the closure gate never looked at.
    expect(productionLayerPaths.length).toBeGreaterThanOrEqual(2)
    expect(required.size).toBeGreaterThan(0)

    const produced = declaredProducers()
    const unproduced = [...required.keys()].filter(name => !produced.has(name)).sort()
    const detail = unproduced.map(name => `${name} (required by ${required.get(name)!.join(', ')})`).join('; ')
    expect(unproduced, `these variables abort the production render but have no operator-facing producer: add the key to .env.example AND a ": "\${NAME:?NAME is required}"" assertion to the ECS preflight: ${detail}`).toEqual([])
  })

  it('renders the whole chain with nothing but those producers', () => {
    const required = requiredProductionVariables()
    const produced = declaredProducers()
    // Only the declared producers are supplied, so a key either half dropped is
    // genuinely absent from this `.env` — exactly as it would be on a deploy
    // host that followed the repository's own template and preflight.
    const env = new Map([...produced].map(name => [name, suppliedValue(name)]))
    const missing = [...required.keys()].filter(name => !env.has(name)).sort()
    expect(missing, `these variables are required by the production chain but were not supplied, because no producer names them: ${missing.join(', ')}`).toEqual([])

    const rendered = renderProductionChain(env)
    expect(rendered.status, `the production Compose chain must render from the repository's own declared variables; docker compose said: ${rendered.stderr.trim().split('\n').slice(0, 5).join(' | ')}`).toBe(0)
    expect(rendered.stderr).not.toMatch(/required variable [A-Z0-9_]+ is missing/)
  })
})
