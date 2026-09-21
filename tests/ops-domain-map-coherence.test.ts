import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { opsDomains } from '../apps/ops-console/src/navigation/opsNavigation.js'
import { domainReadCapabilities } from '../apps/ops-console/src/authz/authorization.js'

/**
 * A domain name is spread over four independent declarations that only agree by
 * convention: `opsDomains` (opsNavigation.ts), `domainReadCapabilities`
 * (authz/authorization.ts), `opsPageRegistry` (navigation/opsPageRegistry.tsx)
 * and `release-metadata.json`'s `opsDomainCount`. Restoring `finance` on
 * 2026-09-20 had to touch all four by hand, and the count assertions that
 * described the surface were hardcoded numbers in test titles, so they could not
 * catch a half-applied edit.
 *
 * The failure this pins is asymmetric and silent in opposite directions:
 * a domain in `opsDomains` but missing from `domainReadCapabilities` makes
 * `OpsConsoleController` evaluate `domainReadCapabilities[activeDomain][0]`
 * against `undefined` and throw on render, while a domain missing from
 * `opsPageRegistry` renders nothing at all — the navigation entry is offered and
 * the pane stays blank. `release-metadata.json` is the third copy: it is only
 * checked by `tests/release-metadata-gate.ts`, which counts the domains by
 * re-parsing the `opsDomains` literal, so it agrees with the navigation file but
 * says nothing about the other two maps.
 *
 * The registry is read as source text rather than imported on purpose: importing
 * it pulls in every page module (React, antd, and the finance/user workspaces
 * that are edited concurrently), so an unrelated in-flight edit to one page
 * would fail this coherence guard. The extractor is exercised by its own test
 * below so a broken parse cannot make the comparisons pass vacuously.
 */
const registrySourcePath = new URL(
  '../apps/ops-console/src/navigation/opsPageRegistry.tsx',
  import.meta.url,
)
const registrySource = readFileSync(registrySourcePath, 'utf8')

/** The keys of the `opsPageRegistry` object literal, in source order. Each key
 * must be followed directly by `lazy(`, so a key without a component (a `null`
 * placeholder or a bare comment) is not counted as coverage. */
function registryDomains(source: string): string[] {
  const declaration = source.indexOf('opsPageRegistry')
  if (declaration < 0) {
    throw new Error('opsPageRegistry is no longer declared in opsPageRegistry.tsx')
  }
  const open = source.indexOf('{', source.indexOf('=', declaration))
  if (open < 0) throw new Error('opsPageRegistry must be initialized with an object literal')

  let depth = 0
  let close = -1
  for (let index = open; index < source.length; index += 1) {
    const character = source[index]
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) {
        close = index
        break
      }
    }
  }
  if (close < 0) throw new Error('opsPageRegistry object literal is unbalanced')

  const body = source.slice(open + 1, close)
  return [...body.matchAll(/(?:^|[,{\s])"?([A-Za-z][A-Za-z0-9-]*)"?\s*:\s*lazy\(/gu)].map(
    (match) => match[1]!,
  )
}

const navigationDomains = [...opsDomains] as string[]
const pageRegistryDomains = registryDomains(registrySource)
const capabilityDomains = Object.keys(domainReadCapabilities)
const sorted = (values: readonly string[]) => [...values].sort()

describe('ops domain map coherence', () => {
  it('keeps navigation, read capabilities and page registry keyed by the same domains', () => {
    // A parse that silently returns nothing would make the comparisons below
    // pass against an empty set, so pin the denominator first.
    expect(navigationDomains.length).toBeGreaterThan(0)

    expect(sorted(pageRegistryDomains)).toEqual(sorted(navigationDomains))
    expect(sorted(capabilityDomains)).toEqual(sorted(navigationDomains))
  })

  it('declares each domain exactly once', () => {
    expect(new Set(navigationDomains).size).toBe(navigationDomains.length)
    expect(new Set(pageRegistryDomains).size).toBe(pageRegistryDomains.length)
  })

  it('keeps the registry entry point typed by OpsDomain so completeness is enforced at build time', () => {
    expect(registrySource).toMatch(/opsPageRegistry:\s*Record<OpsDomain,/u)
  })

  it('gives every domain a page component', () => {
    const registered = new Set(pageRegistryDomains)
    const withoutPage = navigationDomains.filter((domain) => !registered.has(domain))
    expect(withoutPage).toEqual([])
  })

  it('keeps every read capability list non-empty, since the controller indexes [0]', () => {
    for (const domain of opsDomains) {
      const capabilities = domainReadCapabilities[domain]
      expect(Array.isArray(capabilities), domain).toBe(true)
      // OpsConsoleController reads domainReadCapabilities[activeDomain][0] to
      // label the authorization state; an empty list throws on render instead of
      // failing closed.
      expect(capabilities.length, `${domain} must declare at least one read capability`).toBeGreaterThan(0)
      for (const capability of capabilities) {
        expect(capability.trim(), `${domain} declares a blank read capability`).not.toBe('')
      }
    }
  })

  it('matches release-metadata opsDomainCount to the real number of domains', () => {
    const metadata = JSON.parse(
      readFileSync(new URL('../release-metadata.json', import.meta.url), 'utf8'),
    ) as { opsDomainCount?: number }
    // Derived from opsDomains rather than hardcoded: a stale literal here is the
    // drift this asserts against.
    expect(Number.isInteger(metadata.opsDomainCount)).toBe(true)
    expect(metadata.opsDomainCount).toBe(navigationDomains.length)
  })

  it('detects a domain that has navigation but no page component', () => {
    const dropped = registrySource.replace(/^\s*overview: lazy\([\s\S]*?^\s*\),$/mu, '')
    expect(dropped).not.toBe(registrySource)
    const domains = registryDomains(dropped)
    expect(domains).not.toContain('overview')
    expect(navigationDomains.filter((domain) => !domains.includes(domain))).toEqual(['overview'])
  })
})
