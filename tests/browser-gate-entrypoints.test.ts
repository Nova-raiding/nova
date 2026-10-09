/**
 * Pins the browser-gate wiring as it actually is, so that any future change to
 * it is deliberate and visible instead of an accident nobody reviews.
 *
 * Three facts were true of this repository when this file was written, and each
 * was verified by reading `package.json` and the two runners, not assumed:
 *
 *   1. `npm run check` chains none of `test:browser:merchant`,
 *      `test:browser:ops` or `test:browser:ops:jit`. The browser suites need
 *      Docker, a real browser and an isolated password account; folding them into the
 *      deterministic local gate would turn every run red. That is a real gap,
 *      and this file records it (see
 *      `DECLARED_BROWSER_ENTRYPOINTS_UNINVOKED_BY_CHECK`) rather than asserting
 *      it is closed.
 *   2. Each `test:browser:*` script runs a small, explicit, closed set of
 *      specs. `test:browser:ops`, its template and product-import sub-suites,
 *      and `test:browser:ops:jit` name their specs
 *      (or delegate to a fallback) in the script / runner, and
 *      `test:browser:merchant` delegates to a runner that names six specs.
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
  'demo/merchant-studio/image-visual-qa.spec.js',
  'demo/merchant-studio/catalog-search-filters.browser.spec.js',
  'demo/merchant-studio/merchant-risk-destination.browser.spec.js',
  'demo/merchant-studio/overview-finance.browser.spec.js',
  'demo/merchant-studio/upload-rules-journey.browser.spec.js',
  spec('merchant-all.spec.js'),
  spec('merchant-brand-scopes.spec.js'),
  spec('merchant-data-safety.spec.js'),
  spec('merchant-interactions.spec.js'),
  spec('merchant.spec.js'),
].sort()

const OPS_SPECS = [
  spec('ops-all.spec.js'),
  spec('ops-users.spec.js'),
  spec('ops.spec.js'),
].sort()
const OPS_COMMERCIAL_SPECS = [
  spec('ops-commercial-packages-isolated.spec.js'),
  spec('ops-commercial-sales-isolated.spec.js'),
  spec('ops-commercial-support-isolated.spec.js'),
].sort()

const OPS_MATRIX_SPECS = [spec('ops-desktop-readonly-matrix.spec.js')]
const OPS_ACCOUNT_LABEL_SPECS = [spec('ops-account-label-isolated.spec.js')]
const OPS_ACCOUNT_OWNERSHIP_SPECS = [spec('ops-account-ownership-isolated.spec.js')]
const OPS_DESKTOP_STATE_SPECS = [spec('ops-rbac-desktop-matrix.spec.js'), spec('ops-workbench-dirty-guard.spec.js')].sort()
const OPS_TEMPLATE_SPECS = [spec('ops-template-download-isolated.spec.js')]
const OPS_RULE_UPLOAD_SPECS = [spec('ops-rule-upload-isolated.spec.js')]
const OPS_PUBLIC_RULE_UPLOAD_SPECS = [spec('ops-public-rule-upload-isolated.spec.js')]
const OPS_PRODUCT_IMPORT_SPECS = [spec('ops-product-import-scan-isolated.spec.js')]
const OPS_UNMATCHED_READONLY_SPECS = [spec('ops-unmatched-receipt-readonly-isolated.spec.js')]

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
  spec('ops-commercial-benefit-bundles-isolated.spec.js'),
  spec('ops-delivery-account-access.spec.js'),
  spec('ops-delivery-auth-boundary.spec.js'),
  spec('ops-delivery-contract-link.spec.js'),
  spec('ops-delivery-isolated.spec.js'),
  spec('ops-delivery-owner-acceptance.spec.js'),
  spec('ops-delivery-readonly-isolated.spec.js'),
  spec('ops-manual-import-isolated.spec.js'),
  spec('ops-mcp-request-matrix.spec.js'),
  spec('ops-members-global-isolated.spec.js'),
  spec('ops-merchant-matrix-bootstrap.spec.js'),
  spec('knowledge-lexical-upload-isolated.spec.js'),
  spec('ops-merchant-provision-live.spec.js'),
  spec('ops-refund-isolated.spec.js'),
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

  it('runs exactly the three Ops Console specs named in the test:browser:ops command', () => {
    const command = script('test:browser:ops')
    expect(command).toContain('scripts/run-ops-password-e2e.ts')
    expect(specPathsIn(command)).toEqual(OPS_SPECS)
    // The runner is launched with explicit paths; it must not point at a config.
    expect(command).not.toContain('--config')
  })

  it('runs the commercial Ops Console specs through their dedicated entrypoint', () => {
    const command = script('test:browser:ops:commercial')
    expect(command).toContain('scripts/run-ops-password-e2e.ts')
    expect(specPathsIn(command)).toEqual(OPS_COMMERCIAL_SPECS)
    expect(command).not.toContain('--config')
  })

  it('runs the role-gated desktop route matrix in its dedicated isolated fixture', () => {
    const command = script('test:browser:ops:matrix')
    expect(command).toContain('scripts/run-ops-password-e2e.ts')
    expect(specPathsIn(command)).toEqual(OPS_MATRIX_SPECS)
    expect(command).not.toContain('--config')
  })

  it('runs the RBAC and dirty-workbench desktop specs in a dedicated isolated Ops gate', () => {
    const command = script('test:browser:ops:desktop-state')
    expect(command).toContain('scripts/run-ops-password-e2e.ts')
    expect(specPathsIn(command)).toEqual(OPS_DESKTOP_STATE_SPECS)
    expect(command).toContain('--workers=1')
    expect(command).not.toContain('--config')
  })

  it('runs account identity display only through the isolated password-session fixture', () => {
    const command = script('test:browser:ops:account-label')
    expect(command).toContain('scripts/run-ops-password-e2e.ts')
    expect(specPathsIn(command)).toEqual(OPS_ACCOUNT_LABEL_SPECS)
    expect(command).toContain('--workers=1')
    expect(command).not.toContain('--config')
  })

  it('runs account ownership filtering only through the isolated password-session fixture', () => {
    const command = script('test:browser:ops:account-ownership')
    expect(command).toContain('scripts/run-ops-password-e2e.ts')
    expect(specPathsIn(command)).toEqual(OPS_ACCOUNT_OWNERSHIP_SPECS)
    expect(command).toContain('--workers=1')
    expect(command).not.toContain('--config')
  })

  it('delegates test:browser:merchant to a runner that names every merchant browser spec', () => {
    const command = script('test:browser:merchant')
    expect(command).toContain('scripts/merchant-browser-candidate.ts')
    expect(command).not.toContain('--config')
    const runner = readFileSync(resolve(root, 'scripts/merchant-browser-candidate.ts'), 'utf8')
    expect(specPathsIn(runner)).toEqual(MERCHANT_SPECS)
    expect(playwrightInvocation(runner)).not.toContain('--config')
  })

  it('runs merchant member browser acceptance only with the disposable Ops fixture', () => {
    const command = script('test:browser:merchant:members')
    expect(command).toBe('OPS_E2E_MERCHANT_UI=true node --import tsx scripts/verify-merchant-members-isolated.ts')
    const runner = readFileSync(resolve(root, 'scripts/verify-merchant-members-isolated.ts'), 'utf8')
    expect(runner).toContain("runOpsE2e(['dogfood/chatgpt-all-functions/ops-members-global-isolated.spec.js']")
    expect(runner).toContain('fixture.adminDatabaseUrl')
    expect(runner).toContain('productionBrowser: false')
  })

  it('runs the isolated template download browser acceptance from its dedicated entrypoint', () => {
    const command = script('test:browser:ops:template')
    expect(command).toContain('scripts/run-ops-password-e2e.ts')
    expect(specPathsIn(command)).toEqual(OPS_TEMPLATE_SPECS)
    expect(command).not.toContain('--config')
  })

  it('runs platform rule upload only through its dedicated isolated Ops fixture', () => {
    const command = script('test:browser:ops:rule-upload')
    expect(command).toContain('scripts/run-ops-password-e2e.ts')
    expect(specPathsIn(command)).toEqual(OPS_RULE_UPLOAD_SPECS)
    expect(command).not.toContain('--config')
  })

  it('runs public platform rule upload only through its dedicated isolated Ops fixture', () => {
    const command = script('test:browser:ops:public-rule-upload')
    expect(command).toContain('scripts/run-ops-password-e2e.ts')
    expect(specPathsIn(command)).toEqual(OPS_PUBLIC_RULE_UPLOAD_SPECS)
    expect(command).not.toContain('--config')
  })

  it('runs product import only with its dedicated real-scanner fixture and exact spec', () => {
    const command = script('test:browser:ops:product-import')
    expect(command).toContain('OPS_E2E_DELIVERY_SCAN=true OPS_E2E_SCAN_PURPOSE=product_import OPS_E2E_SCANNER_STARTUP_TIMEOUT_MS=300000')
    expect(command).toContain('scripts/run-ops-password-e2e.ts')
    expect(specPathsIn(command)).toEqual(OPS_PRODUCT_IMPORT_SPECS)
    expect(command).not.toContain('--config')
  })

  it('runs unmatched-receipt read-only authorization only in its dedicated isolated fixture', () => {
    const command = script('test:browser:ops:unmatched-readonly')
    expect(command).toContain('scripts/run-ops-password-e2e.ts')
    expect(specPathsIn(command)).toEqual(OPS_UNMATCHED_READONLY_SPECS)
    expect(command).not.toContain('--config')
  })

  it('gives test:browser:ops:jit no spec, so it runs the runner fallback spec', () => {
    const command = script('test:browser:ops:jit')
    expect(command).toContain('scripts/run-ops-password-e2e.ts')
    expect(specPathsIn(command)).toEqual([])
    expect(command).not.toContain('--config')
    const runner = readFileSync(resolve(root, 'scripts/run-ops-password-e2e.ts'), 'utf8')
    // Other literal paths in the runner belong to dedicated opt-in suites and
    // must never be inferred as a run from this no-argument fallback.
    expect(runner).toContain("return args.length ? [...args] : ['dogfood/chatgpt-all-functions/ops-jit-isolated.spec.js']")
    expect(playwrightInvocation(runner)).not.toContain('--config')
    expect(runner).toContain('OPS_E2E_OVERRIDE_NOT_ALLOWED')
  })

  it('composes test:browser:all from merchant, desktop creative, and every dedicated Ops acceptance suite', () => {
    const all = script('test:browser:all')
    expect(all).toBe('npm run test:browser:merchant && npm run test:browser:merchant:members && npm run test:browser:canonical-desktop && npm run test:browser:image-generation-desktop && npm run test:browser:material-assets && npm run test:browser:ops && npm run test:browser:ops:commercial && npm run test:browser:ops:matrix && npm run test:browser:ops:desktop-state && npm run test:browser:ops:account-label && npm run test:browser:ops:account-ownership && npm run test:browser:ops:template && npm run test:browser:ops:rule-upload && npm run test:browser:ops:public-rule-upload && npm run test:browser:ops:unmatched-readonly && npm run test:browser:ops:product-import')
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

    const runByBrowserScripts = new Set([...MERCHANT_SPECS, ...OPS_SPECS, ...OPS_COMMERCIAL_SPECS, ...OPS_MATRIX_SPECS, ...OPS_DESKTOP_STATE_SPECS, ...OPS_ACCOUNT_LABEL_SPECS, ...OPS_ACCOUNT_OWNERSHIP_SPECS, ...OPS_TEMPLATE_SPECS, ...OPS_RULE_UPLOAD_SPECS, ...OPS_PUBLIC_RULE_UPLOAD_SPECS, ...OPS_PRODUCT_IMPORT_SPECS, ...OPS_UNMATCHED_READONLY_SPECS, spec('ops-jit-isolated.spec.js')])
    const configOnly = [...configMatched].filter(file => !runByBrowserScripts.has(file)).sort()
    expect(configOnly.length, 'an empty claim list would make this assertion vacuous').toBeGreaterThan(0)
    expect(configOnly).toEqual(CONFIG_ONLY_BROWSER_SPECS)
  })
})
