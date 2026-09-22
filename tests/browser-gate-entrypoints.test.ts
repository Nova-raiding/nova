/**
 * Pins the browser-gate wiring as it actually is, so that any future change to
 * it is deliberate and visible instead of an accident nobody reviews.
 *
 * Three facts were true of this repository when this file was written, and each
 * was verified by reading `package.json` and the two runners, not assumed:
 *
 *   1. `npm run check` chains none of `test:browser:merchant`,
 *      `test:browser:ops` or `test:browser:ops:jit`. The browser suites need
 *      Docker, a real browser and a signed OIDC identity; folding them into the
 *      deterministic local gate would turn every run red. That is a real gap,
 *      and this file records it (see
 *      `DECLARED_BROWSER_ENTRYPOINTS_UNINVOKED_BY_CHECK`) rather than asserting
 *      it is closed.
 *   2. Each `test:browser:*` script runs a small, explicit, closed set of
 *      specs. `test:browser:ops` and `test:browser:ops:jit` name their specs
 *      (or delegate to a fallback) in the script / runner, and
 *      `test:browser:merchant` delegates to a runner that names four specs.
 *      Those sets are pinned below.
 *   3. The entrypoint ledger's browser half is satisfied by
 *      `dogfood/chatgpt-all-functions/playwright.config.mjs`, whose
 *      `testMatch` is `**\/*.spec.js` over its own directory. No runner ever
 *      loads it: both invoke the Playwright CLI with explicit paths and without
 *      `--config`, and Playwright's config auto-discovery looks only in the
 *      process working directory (the repository root), where no
 *      `playwright.config.*` exists. So the config schedules a superset of the
 *      specs any browser entrypoint actually runs — the specs in that
 *      difference are pinned in `CONFIG_ONLY_BROWSER_SPECS`.
 *
 * When the wiring changes, this file fails and must be updated in the same
 * change. That is the point: the update is the review.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { filesOnDisk, playwrightCollectedSpecs } from './test-entrypoint-coverage.js'

const root = resolve(import.meta.dirname, '..')
const DOGFOOD_DIR = 'dogfood/chatgpt-all-functions'

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

function script(name: string): string {
  const command = packageJson.scripts[name]
  expect(command, `package.json declares no script named ${name}`).toBeTypeOf('string')
  return command ?? ''
}

function spec(name: string): string {
  return `${DOGFOOD_DIR}/${name}`
}

/** Every `*.spec.js` path appearing in a command line or a source file. */
const SPEC_PATH = /[A-Za-z0-9_][A-Za-z0-9_./-]*\.spec\.js/gu

function specPathsIn(text: string): string[] {
  return [...new Set(text.match(SPEC_PATH) ?? [])].sort()
}

/**
 * The Playwright CLI invocation inside a runner, isolated from any other
 * `--config` in the same file. The ops runner legitimately passes `--config` to
 * `vite build` for its UI bundle; that is a different command and must not be
 * confused with a config handed to the browser run.
 */
function playwrightInvocation(source: string): string {
  const lines = source
    .split('\n')
    .filter(line => line.includes('@playwright/test/cli.js') || line.includes("'playwright', 'test'"))
  expect(lines.length, 'no Playwright CLI invocation was found in the runner').toBeGreaterThan(0)
  return lines.join('\n')
}

const MERCHANT_SPECS = [
  spec('merchant-all.spec.js'),
  spec('merchant-data-safety.spec.js'),
  spec('merchant-interactions.spec.js'),
  spec('merchant.spec.js'),
].sort()

const OPS_SPECS = [
  spec('ops-all.spec.js'),
  spec('ops-users.spec.js'),
  spec('ops-workspace-visual.spec.js'),
  spec('ops.spec.js'),
].sort()

const OPS_JIT_SPECS = [spec('ops-jit-isolated.spec.js')]

/**
 * `package.json` entrypoints that declare browser coverage but that `npm run
 * check` never chains. Closing this gap means chaining a Docker + browser +
 * OIDC run into the deterministic local gate, which is a separate decision for
 * a separate change — so the gap is named here instead of asserted shut. If one
 * of these is wired into `check`, remove it from this list in the same change;
 * the assertion below fails otherwise.
 */
const DECLARED_BROWSER_ENTRYPOINTS_UNINVOKED_BY_CHECK = [
  'test:browser:merchant',
  'test:browser:ops',
  'test:browser:ops:jit',
] as const

/**
 * Specs that `dogfood/chatgpt-all-functions/playwright.config.mjs` matches and
 * that no `test:browser:*` script runs. The ledger counts these as "scheduled",
 * because it credits a `playwright.config.*` `testMatch` — but nothing loads
 * that config, so no browser entrypoint executes them. Pin the list so the
 * ledger's over-claim stays visible and a change to either side is deliberate.
 */
const CONFIG_ONLY_BROWSER_SPECS = [
  spec('canonical-product-desktop.spec.js'),
  spec('image-generation-desktop.spec.js'),
  spec('merchant-production-readonly.spec.js'),
  spec('merchant-workspace-roles.spec.js'),
  spec('ops-account-label-isolated.spec.js'),
  spec('ops-delivery-account-access.spec.js'),
  spec('ops-delivery-auth-boundary.spec.js'),
  spec('ops-delivery-contract-link.spec.js'),
  spec('ops-delivery-isolated.spec.js'),
  spec('ops-delivery-owner-acceptance.spec.js'),
  spec('ops-delivery-readonly-isolated.spec.js'),
  spec('ops-mcp-request-matrix.spec.js'),
  spec('ops-rbac-desktop-matrix.spec.js'),
  spec('ops-workbench-dirty-guard.spec.js'),
].sort()

const PLAYWRIGHT_CONFIG = `${DOGFOOD_DIR}/playwright.config.mjs`

describe('browser gate entrypoints', () => {
  it('extracts spec paths rather than silently returning nothing', () => {
    // Without this the assertions below could pass against an empty list if the
    // extractor stopped matching, which is exactly the failure mode being
    // guarded: a green check over no coverage.
    expect(specPathsIn(`node --import tsx run.ts ${DOGFOOD_DIR}/example.spec.js --workers=1`)).toEqual([
      `${DOGFOOD_DIR}/example.spec.js`,
    ])
    expect(specPathsIn('node --import tsx run.ts --workers=1')).toEqual([])
  })

  it('runs exactly the four ops specs named in the test:browser:ops command', () => {
    const command = script('test:browser:ops')
    expect(command).toContain('scripts/run-ops-oidc-e2e.ts')
    expect(specPathsIn(command)).toEqual(OPS_SPECS)
    // The runner is launched with explicit paths; it must not point at a config.
    expect(command).not.toContain('--config')
  })

  it('delegates test:browser:merchant to a runner that names exactly four spec files', () => {
    const command = script('test:browser:merchant')
    expect(command).toContain('scripts/merchant-browser-candidate.ts')
    expect(command).not.toContain('--config')
    const runner = readFileSync(resolve(root, 'scripts/merchant-browser-candidate.ts'), 'utf8')
    expect(specPathsIn(runner)).toEqual(MERCHANT_SPECS)
    expect(playwrightInvocation(runner)).not.toContain('--config')
  })

  it('gives test:browser:ops:jit no spec, so it runs the runner fallback spec', () => {
    const command = script('test:browser:ops:jit')
    expect(command).toContain('scripts/run-ops-oidc-e2e.ts')
    expect(specPathsIn(command)).toEqual([])
    expect(command).not.toContain('--config')
    const runner = readFileSync(resolve(root, 'scripts/run-ops-oidc-e2e.ts'), 'utf8')
    // The runner's only literal spec path is the no-argument fallback, and its
    // argument validator rejects anything but spec paths, --workers=1 and
    // --grep, so `--config` can never reach the Playwright CLI through it.
    expect(specPathsIn(runner)).toEqual(OPS_JIT_SPECS)
    expect(playwrightInvocation(runner)).not.toContain('--config')
    expect(runner).toContain('OPS_E2E_OVERRIDE_NOT_ALLOWED')
  })

  it('composes test:browser:all from merchant and ops only, leaving jit standalone', () => {
    const all = script('test:browser:all')
    expect(all).toBe('npm run test:browser:merchant && npm run test:browser:ops')
    expect(all).not.toContain('test:browser:ops:jit')
  })

  it('leaves the declared browser entrypoints unchained from check, and says so', () => {
    const check = script('check')
    // Deliberate gap: `check` stays hermetic, so it names no browser entrypoint.
    expect(check).not.toContain('test:browser')
    for (const name of DECLARED_BROWSER_ENTRYPOINTS_UNINVOKED_BY_CHECK) {
      expect(packageJson.scripts[name], `${name} is listed as declared but no longer exists`).toBeTypeOf('string')
      expect(check, `${name} was wired into check; update the gap constant in the same change`).not.toContain(name)
    }
  })

  it('keeps the only playwright config off the runners: no --config, no root config', () => {
    const configs = filesOnDisk(root, name => /^playwright\.config\.[cm]?[jt]s$/u.test(name))
    expect(configs).toEqual([PLAYWRIGHT_CONFIG])
    // Playwright resolves a config directory-only from the process working
    // directory and does not walk upward. The runners inherit the repository
    // root as cwd, which holds no config, so the dogfood config is never
    // selected unless a caller passes it with --config — and none does.
    expect(configs.some(file => !file.includes('/')), 'a root-level playwright.config.* would change browser config resolution').toBe(false)
  })

  it('records the specs the unused playwright config claims but no browser script runs', () => {
    const configMatched = playwrightCollectedSpecs(root)
    expect(configMatched.size, 'the config matched nothing, so the ledger credit is vacuous').toBeGreaterThan(0)
    expect([...configMatched].filter(file => !file.startsWith(`${DOGFOOD_DIR}/`))).toEqual([])

    const runByBrowserScripts = new Set([...MERCHANT_SPECS, ...OPS_SPECS, ...OPS_JIT_SPECS])
    const configOnly = [...configMatched].filter(file => !runByBrowserScripts.has(file)).sort()
    expect(configOnly.length, 'an empty claim list would make this assertion vacuous').toBeGreaterThan(0)
    expect(configOnly).toEqual(CONFIG_ONLY_BROWSER_SPECS)
  })
})
