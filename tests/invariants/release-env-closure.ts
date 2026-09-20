import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The single producer oracle for the production Compose chain.
 *
 * This module is the one place that decides what counts as a "producer" for a
 * `${VAR:?}` variable, so the closure gate
 * (`tests/ecs-compose-release-gate.test.ts`) and the invariant evidence
 * (`tests/release-env-closure.invariant.test.ts`) cannot drift into two
 * different definitions of "closed" — the asymmetry that let the first version
 * of that gate report a closed loop while the render still exited 1.
 *
 * A producer is one of exactly two things, and a variable needs BOTH:
 *
 *   1. `infra/scripts/*.sh` — a `: "${VAR:?VAR is required}"` assertion. This
 *      is the contract that runs before the render, so a missing key is named
 *      instead of disappearing into `docker compose`'s truncated interpolation
 *      errors (Compose stops after 91 of them and the base layers' failures
 *      crowd out the release layer's).
 *   2. `.env.example` — the deploy `.env` template the operator fills in. It is
 *      the only env template in the repository.
 *
 * Either half alone is not a producer: an assertion never reaches the `.env`
 * the renderer reads, and a template key with no contract is a blank nobody
 * knows how to fill. Requiring both is what the runbooks promise
 * (`doc/todo/release/production-ops-runbook.md`, "八个变量必须同时出现在两处
 * 生产者"), and it is what makes the mutation "delete the preflight
 * declaration" turn the render evidence red: with the weaker union rule that
 * key is still "declared" by the template, so the render succeeds and the
 * missing contract goes unnoticed.
 */
export const productionLayerPaths: readonly string[] = readFileSync('infra/local/ecs-production-compose.layers', 'utf8').trim().split('\n')

/** Variable -> the production layers that refuse to interpolate without it. */
export function requiredProductionVariables(): Map<string, string[]> {
  const byVariable = new Map<string, string[]>()
  for (const layer of productionLayerPaths) {
    for (const match of readFileSync(layer, 'utf8').matchAll(/\$\{([A-Z0-9_]+):\?/gu)) {
      byVariable.set(match[1]!, [...(byVariable.get(match[1]!) ?? []), layer])
    }
  }
  return byVariable
}

/** Keys the deploy `.env` template declares. */
export function envTemplateKeys(): Set<string> {
  return new Set([...readFileSync('.env.example', 'utf8').matchAll(/^([A-Z][A-Z0-9_]*)=/gmu)].map(match => match[1]!))
}

/** Variables a repository script refuses to run without (`: "${VAR:?`). */
export function preflightAssertions(): Set<string> {
  const asserted = new Set<string>()
  for (const entry of readdirSync('infra/scripts')) {
    if (!entry.endsWith('.sh')) continue
    for (const match of readFileSync(join('infra/scripts', entry), 'utf8').matchAll(/: "\$\{([A-Z0-9_]+):\?/gu)) asserted.add(match[1]!)
  }
  return asserted
}

/** The variables an operator can find a producer for: both halves, or nothing. */
export function declaredProducers(): Set<string> {
  const inTemplate = envTemplateKeys()
  return new Set([...preflightAssertions()].filter(name => inTemplate.has(name)))
}
