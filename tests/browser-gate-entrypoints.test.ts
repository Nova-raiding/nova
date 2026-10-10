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
 *      `testMatch` is `**\/*.spec.js` over its own directory. Most browser
 *      runners invoke Playwright with explicit paths and without `--config`,
 *      so Playwright's config auto-discovery looks only in the process working
 *      directory (the repository root), where no `playwright.config.*`
 *      exists. The task-queue fixture is the exception: its dedicated package
 *      script explicitly loads the dogfood config. The config-only specs are
 *      the matched set minus every spec named by an actual browser entrypoint,
 *      pinned in `CONFIG_ONLY_BROWSER_SPECS`.
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
const OPS_BENEFIT_BUNDLE_SPECS = [spec('ops-commercial-benefit-bundles-isolated.spec.js')]
const OPS_REFUND_SPECS = [spec('ops-refund-isolated.spec.js')]
const LOCAL_MOCKED_STATE_SPECS = [spec('canonical-product-desktop.spec.js')]
const MERCHANT_TASK_QUEUE_SPECS = [spec('task-queue-split-flow.spec.js')]
const MERCHANT_IMAGE_GENERATION_SPECS = [spec('image-generation-desktop.spec.js')]
const MERCHANT_WORKSPACE_SWITCH_SPECS = ['demo/merchant-studio/merchant-workspace-switch.browser.spec.js']
const MERCHANT_CATALOG_READ_RETRY_SPECS = ['demo/merchant-studio/catalog-read-retry.browser.spec.js']
const MERCHANT_SESSION_RETRY_SPECS = ['demo/merchant-studio/merchant-session-retry.browser.spec.js']
const MERCHANT_RECYCLE_BIN_SPECS = ['demo/merchant-studio/material-recycle-bin.browser.spec.js']
const MERCHANT_GLOBAL_CATALOG_SEARCH_SPECS = [
  'demo/merchant-studio/global-catalog-search.browser.spec.js',
  'demo/merchant-studio/topbar-global-search.browser.spec.js',
].sort()
const MERCHANT_COMMERCIAL_PURCHASE_SPECS = ['demo/merchant-studio/commercial-purchase-center.browser.spec.js']
const MERCHANT_STORE_REGISTRATION_SPECS = ['demo/merchant-studio/manual-store-registration.browser.spec.js']
const MERCHANT_URL_ROUTE_MATRIX_SPECS = ['demo/merchant-studio/url-direct-route-matrix.browser.spec.js']
const MERCHANT_OVERVIEW_JOURNEY_SPECS = [
  'demo/merchant-studio/merchant-risk-destination.browser.spec.js',
  'demo/merchant-studio/overview-finance.browser.spec.js',
].sort()
const MERCHANT_READ_RECOVERY_SPECS = [
  'demo/merchant-studio/commercial-subscription-read-retry.browser.spec.js',
  'demo/merchant-studio/delivery-readiness-recovery.browser.spec.js',
]
const MERCHANT_LOGIN_ONBOARDING_SPECS = ['demo/merchant-studio/merchant-login-onboarding.browser.spec.js']
const MERCHANT_RULES_SPECS = ['demo/merchant-studio/rules-page-interactions.browser.spec.js']

const OPS_MATRIX_SPECS = [spec('ops-desktop-readonly-matrix.spec.js')]
const OPS_ACCOUNT_LABEL_SPECS = [spec('ops-account-label-isolated.spec.js')]
const OPS_ACCOUNT_OWNERSHIP_SPECS = [spec('ops-account-ownership-isolated.spec.js')]
const OPS_DESKTOP_STATE_SPECS = [spec('ops-rbac-desktop-matrix.spec.js'), spec('ops-workbench-dirty-guard.spec.js')].sort()
const OPS_TEMPLATE_SPECS = [spec('ops-template-download-isolated.spec.js')]
const OPS_RULE_UPLOAD_SPECS = [spec('ops-rule-upload-isolated.spec.js')]
const OPS_PUBLIC_RULE_UPLOAD_SPECS = [spec('ops-public-rule-upload-isolated.spec.js')]
const OPS_PRODUCT_IMPORT_SPECS = [spec('ops-product-import-scan-isolated.spec.js')]
const OPS_UNMATCHED_READONLY_SPECS = [spec('ops-unmatched-receipt-readonly-isolated.spec.js')]
const OPS_DELIVERY_READONLY_SPECS = [spec('ops-delivery-readonly-isolated.spec.js')]
const OPS_MANUAL_IMPORT_SPECS = [spec('ops-manual-import-isolated.spec.js')]
const OPS_MCP_REQUEST_MATRIX_SPECS = [spec('ops-mcp-request-matrix.spec.js')]
const OPS_MERCHANT_MATRIX_BOOTSTRAP_SPECS = [spec('ops-merchant-matrix-bootstrap.spec.js')]
const OPS_MERCHANT_PROVISION_SPECS = [spec('ops-merchant-provision-live.spec.js')]
const OPS_DELIVERY_CONTRACT_LINK_SPECS = [spec('ops-delivery-contract-link.spec.js')]
const OPS_DELIVERY_ACCOUNT_ACCESS_SPECS = [spec('ops-delivery-account-access.spec.js')]

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
 * that config for these specs, so no browser entrypoint executes them. The
 * task-queue fixture is excluded because its dedicated script loads the config
 * with an explicit spec path. Pin this list so the ledger's over-claim stays
 * visible and a change to either side is deliberate.
 */
const CONFIG_ONLY_BROWSER_SPECS = [
  spec('merchant-production-readonly.spec.js'),
  spec('merchant-workspace-roles.spec.js'),
  // These Ops workspace-denial probes import openWorkspaceConsole, which the
  // current platform-only Ops auth helper does not export. Keep them visible
  // as blocked until a supported workspace auth surface and isolated identity
  // exist; never claim them as local browser coverage.
  spec('ops-delivery-auth-boundary.spec.js'),
  spec('ops-delivery-isolated.spec.js'),
  spec('ops-delivery-owner-acceptance.spec.js'),
  spec('knowledge-lexical-upload-isolated.spec.js'),
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

  it.each([
    ['Ops overview page', 'src/pages/OverviewPage.browser.test.tsx'],
    ['Ops navigation', 'src/navigation/OpsNavigation.browser.test.tsx'],
    ['Ops permission recovery', 'src/components/OpsPageError.browser.test.tsx'],
    ['Ops commercial refund validation', 'src/components/commercial/CommercialRefundOperationsPanel.browser.test.tsx'],
    ['Ops commercial point adjustment', 'src/components/commercial/PointAdjustmentPanel.browser.test.tsx'],
    ['Ops support row interaction', 'src/components/support/SupportQueueSection.row-interaction.browser.test.tsx'],
    ['Ops controller identity route', 'src/pages/OpsConsoleController.identity-route.browser.test.tsx'],
    ['Ops refund validation', 'src/components/finance/RefundSection.validation.browser.test.tsx'],
    ['Ops header', 'src/components/OpsHeader.test.tsx'],
    ['Ops delivery training toggle', 'src/components/delivery/CustomerDeliveryTrainingToggle.test.tsx'],
    ['Ops delivery upload', 'src/components/delivery/CustomerDeliveryUpload.test.tsx'],
    ['Ops member session boundary', 'src/components/finance/MembersSection.session-boundary.test.tsx'],
    ['Ops authorization governance', 'src/components/users/AuthorizationGovernanceSection.test.tsx'],
    ['Ops registration applications', 'src/components/users/RegistrationApplications.test.tsx'],
    ['Ops workspace governance', 'src/components/users/WorkspaceGovernanceSection.browser.test.tsx'],
    ['Ops denied governance', 'src/components/users/UsersGovernanceDenied.browser.test.tsx'],
    ['Ops alert polling boundary', 'src/hooks/alertPollingBoundary.test.tsx'],
    ['Ops workspace directory model', 'src/hooks/useOpsConsoleModel.workspaceDirectory.test.tsx'],
    ['Ops customer delivery page', 'src/pages/CustomerDeliveryPage.test.tsx'],
    ['Ops customer delivery authorization workspace', 'src/pages/CustomerDeliveryAuthorizationWorkspace.e2e.test.ts'],
    ['Ops customer delivery workspace race', 'src/pages/customer-delivery-workspace-race.test.tsx'],
  ])('keeps %s coverage out of the unit pass and in the dedicated Ops runner', (_label, file) => {
    const opsPackage = JSON.parse(readFileSync(resolve(root, 'apps/ops-console/package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    const [unitCommand, browserCommand] = opsPackage.scripts.test!.split(' && ')
    expect(unitCommand).toContain(`--exclude=${file}`)
    expect(browserCommand).toBe('npm run test:browser')
    expect(opsPackage.scripts['test:browser']).toBe('node scripts/run-browser-tests.mjs')
    const browserRunner = readFileSync(resolve(root, 'apps/ops-console/scripts/run-browser-tests.mjs'), 'utf8')
    const browserRunnerPaths = [...browserRunner.matchAll(/^\s+"(src\/[^"]+)"/gm)].map(([, path]) => path)
    expect(browserRunnerPaths.filter(path => path === file)).toHaveLength(1)
  })

  it('runs the commercial Ops Console specs through their dedicated entrypoint', () => {
    const command = script('test:browser:ops:commercial')
    expect(command).toContain('scripts/run-ops-password-e2e.ts')
    expect(specPathsIn(command)).toEqual(OPS_COMMERCIAL_SPECS)
    expect(command).not.toContain('--config')
  })

  it('runs benefit bundle lifecycle only through its dedicated isolated fixture', () => {
    const command = script('test:browser:ops:benefit-bundles')
    expect(command).toContain('scripts/run-ops-password-e2e.ts')
    expect(specPathsIn(command)).toEqual(OPS_BENEFIT_BUNDLE_SPECS)
    expect(command).toContain('--workers=1')
    expect(command).not.toContain('--config')
  })

  it('runs refund authorization and absent-record probes only through isolated disposable Ops data', () => {
    const command = script('test:browser:ops:refund')
    expect(command).toContain('scripts/run-ops-password-e2e.ts')
    expect(specPathsIn(command)).toEqual(OPS_REFUND_SPECS)
    expect(command).toContain('--workers=1')
    expect(command).not.toContain('--config')
  })

  it('runs image task presentation through real disposable merchant auth and forbids generation writes', () => {
    const command = script('test:browser:merchant:image-generation-isolated')
    expect(command).toContain('OPS_E2E_MERCHANT_UI=true')
    expect(command).toContain('scripts/run-ops-password-e2e.ts')
    expect(specPathsIn(command)).toEqual(MERCHANT_IMAGE_GENERATION_SPECS)
    const runner = readFileSync(resolve(root, 'scripts/run-ops-password-e2e.ts'), 'utf8')
    expect(runner).toContain("argument === 'dogfood/chatgpt-all-functions/image-generation-desktop.spec.js' && source.OPS_E2E_MERCHANT_UI === 'true'")
  })

  it('runs the task queue and split-group browser fixture with the dogfood Playwright config', () => {
    const command = script('test:browser:merchant:task-queue')
    expect(command).toContain('--config=dogfood/chatgpt-all-functions')
    expect(specPathsIn(command)).toEqual(MERCHANT_TASK_QUEUE_SPECS)
    expect(command).toContain('--workers=1')
    expect(command).toContain('TASK_QUEUE_BROWSER_FIXTURE=1')
  })

  it('runs global merchant workspace switching through a dedicated dual-workspace isolated fixture', () => {
    const command = script('test:browser:merchant:workspace-switch')
    expect(command).toContain('OPS_E2E_MERCHANT_WORKSPACE_SWITCH=true')
    expect(command).toContain('OPS_E2E_MERCHANT_UI=true')
    expect(command).toContain('scripts/verify-merchant-workspace-isolated.ts')
    const runner = readFileSync(resolve(root, 'scripts/verify-merchant-workspace-isolated.ts'), 'utf8')
    expect(specPathsIn(runner)).toEqual(MERCHANT_WORKSPACE_SWITCH_SPECS)
    expect(runner).toContain('fixture.adminDatabaseUrl')
    expect(runner).toContain('fixture.opsDatabaseUrl')
    expect(runner).toContain('productionBrowser: false')
    const browserSpec = readFileSync(resolve(root, MERCHANT_WORKSPACE_SWITCH_SPECS[0]!), 'utf8')
    expect(browserSpec).toContain("['A', 'B', 'A']")
    expect(browserSpec).toContain("request.headers()['x-workspace-id']")
    expect(browserSpec).toContain('old-workspace-search-marker')
  })

  it('registers the product catalog read-retry browser regression', () => {
    const command = script('test:browser:merchant:catalog-read-retry')
    expect(specPathsIn(command)).toEqual(MERCHANT_CATALOG_READ_RETRY_SPECS)
    expect(command).toContain('--config=demo/merchant-studio')
    expect(command).toContain('--workers=1')
  })

  it('registers the local merchant session failure and retry recovery browser regression', () => {
    const command = script('test:browser:merchant:session-retry')
    expect(specPathsIn(command)).toEqual(MERCHANT_SESSION_RETRY_SPECS)
    expect(command).toContain('--config=demo/merchant-studio')
    expect(command).toContain('--workers=1')
    expect(script('test:browser:all')).toContain('npm run test:browser:merchant:session-retry')
  })

  it('registers the support whitespace validation browser regression', () => {
    const command = script('test:browser:ops:support-whitespace')
    expect(command).toContain('scripts/run-safe-tests.ts')
    expect(command).toContain('apps/ops-console/src/components/support/SupportQueueSection.whitespace-validation.browser.test.tsx')
    expect(script('test:browser:all')).toContain('npm run test:browser:ops:support-whitespace')
  })

  it('registers the merchant manual store registration browser journey', () => {
    const command = script('test:browser:merchant:store-registration')
    expect(specPathsIn(command)).toEqual(MERCHANT_STORE_REGISTRATION_SPECS)
    expect(command).toContain('MERCHANT_CATALOG_BROWSER_FIXTURE=1')
    expect(command).toContain('MERCHANT_BROWSER_SPEC_DIR=repo')
    expect(command).toContain('--config=dogfood/chatgpt-all-functions')
    expect(command).toContain('--workers=1')
  })

  it('registers the local merchant URL direct-route matrix', () => {
    const command = script('test:browser:merchant:url-route-matrix')
    expect(specPathsIn(command)).toEqual(MERCHANT_URL_ROUTE_MATRIX_SPECS)
    expect(command).toContain('--config=demo/merchant-studio')
    expect(command).toContain('--workers=1')
  })

  it('registers the recycle-bin read-retry and restore browser journey', () => {
    const command = script('test:browser:merchant:recycle-bin')
    expect(specPathsIn(command)).toEqual(MERCHANT_RECYCLE_BIN_SPECS)
    expect(command).toContain('--config=demo/merchant-studio')
    expect(command).toContain('--workers=1')
  })

  it('runs global catalog search and topbar search through a read-only isolated fixture', () => {
    const command = script('test:browser:merchant:global-catalog-search')
    expect(specPathsIn(command)).toEqual(MERCHANT_GLOBAL_CATALOG_SEARCH_SPECS)
    expect(command).toContain('MERCHANT_CATALOG_BROWSER_FIXTURE=1')
    expect(command).toContain('MERCHANT_BROWSER_SPEC_DIR=repo')
    expect(command).toContain('--config=dogfood/chatgpt-all-functions')
    expect(command).toContain('--workers=1')
  })

  it('registers the commercial first-purchase browser journey in its isolated fixture', () => {
    const command = script('test:browser:merchant:commercial-purchase')
    expect(specPathsIn(command)).toEqual(MERCHANT_COMMERCIAL_PURCHASE_SPECS)
    expect(command).toContain('MERCHANT_CATALOG_BROWSER_FIXTURE=1')
    expect(command).toContain('MERCHANT_BROWSER_SPEC_DIR=repo')
    expect(command).toContain('--config=dogfood/chatgpt-all-functions')
    expect(command).toContain('--workers=1')
  })

  it('registers rules route/filter browser regressions', () => {
    const command = script('test:browser:merchant:rules')
    expect(specPathsIn(command)).toEqual(MERCHANT_RULES_SPECS)
    expect(command).toContain('--config=demo/merchant-studio')
    expect(command).toContain('--workers=1')
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

  it('keeps the workspace-denial probes blocked until their missing Ops auth helper exists', () => {
    const auth = readFileSync(resolve(root, `${DOGFOOD_DIR}/ops-auth.js`), 'utf8')
    expect(auth).toContain('Ops Console is platform-only')
    expect(auth).not.toContain('export async function openWorkspaceConsole')
    expect(packageJson.scripts['test:browser:ops:delivery-isolated']).toBeUndefined()
    expect(packageJson.scripts['test:browser:ops:delivery-owner']).toBeUndefined()
    expect(script('test:browser:all')).not.toContain('test:browser:ops:delivery-isolated')
    expect(script('test:browser:all')).not.toContain('test:browser:ops:delivery-owner')
    for (const name of ['ops-delivery-auth-boundary.spec.js', 'ops-delivery-isolated.spec.js', 'ops-delivery-owner-acceptance.spec.js']) {
      expect(CONFIG_ONLY_BROWSER_SPECS).toContain(spec(name))
      expect(readFileSync(resolve(root, `${DOGFOOD_DIR}/${name}`), 'utf8')).toContain('openWorkspaceConsole')
    }
  })

  it('runs read-only delivery through its dedicated disposable Ops fixture', () => {
    const readonly = script('test:browser:ops:delivery-readonly')
    expect(readonly).toContain('scripts/run-ops-password-e2e.ts')
    expect(specPathsIn(readonly)).toEqual(OPS_DELIVERY_READONLY_SPECS)
    expect(readonly).toContain('--workers=1')
    expect(readonly).not.toContain('OPS_E2E_DELIVERY_SCAN=true')
  })

  it('runs manual import alone with the dedicated isolated manual-operations mode', () => {
    const command = script('test:browser:ops:manual-import')
    expect(command).toContain('OPS_E2E_MANUAL_OPERATIONS=true')
    expect(command).toContain('scripts/run-ops-password-e2e.ts')
    expect(specPathsIn(command)).toEqual(OPS_MANUAL_IMPORT_SPECS)
    expect(command).toContain('--workers=1')
    expect(command).not.toContain('--config')
  })

  it('runs the MCP request matrix through the disposable Ops password-session fixture', () => {
    const command = script('test:browser:ops:mcp-request-matrix')
    expect(command).toContain('scripts/run-ops-password-e2e.ts')
    expect(specPathsIn(command)).toEqual(OPS_MCP_REQUEST_MATRIX_SPECS)
    expect(command).toContain('--workers=1')
    expect(command).not.toContain('--config')
  })

  it('runs merchant desktop matrix only through its isolated Ops plus Merchant fixture', () => {
    expect(script('test:browser:merchant:desktop-matrix')).toBe('node --import tsx scripts/merchant-isolated-screenshot-matrix.ts')
    const runner = readFileSync(resolve(root, 'scripts/merchant-isolated-screenshot-matrix.ts'), 'utf8')
    expect(specPathsIn(runner)).toEqual(OPS_MERCHANT_MATRIX_BOOTSTRAP_SPECS)
    expect(runner).toContain('OPS_E2E_MERCHANT_UI')
    expect(runner).toContain('runOpsE2e(')
    expect(runner).toContain('productionBrowser: false')
  })

  it('binds merchant provisioning only to the exact workspace from its disposable fixture', () => {
    const command = script('test:browser:ops:merchant-provision-isolated')
    expect(command).toBe('node --import tsx scripts/verify-ops-merchant-provision-isolated.ts')
    const runner = readFileSync(resolve(root, 'scripts/verify-ops-merchant-provision-isolated.ts'), 'utf8')
    expect(specPathsIn(runner)).toEqual(OPS_MERCHANT_PROVISION_SPECS)
    expect(runner).toContain('OPS_E2E_MERCHANT_PROVISION = \'true\'')
    expect(runner).toContain('fixture.workspaceId !== expectedWorkspaceId')
    expect(runner).toContain('environment.OPS_PROVISION_QA_WORKSPACE_CONFIRMED = fixture.workspaceId')
    expect(runner).toContain('environment.OPS_PROVISION_QA_WORKSPACE_ID = fixture.workspaceId')
    expect(runner).toContain('url.hostname !== \'127.0.0.1\'')
    expect(runner).toContain('OPS_PROVISION_OUTPUT_DIR = resolve(evidenceDir')
  })

  it.each([
    ['test:browser:ops:delivery-contract-link', 'scripts/verify-customer-delivery-contract-link.ts', OPS_DELIVERY_CONTRACT_LINK_SPECS],
    ['test:browser:ops:delivery-account-access', 'scripts/verify-customer-delivery-account-access.ts', OPS_DELIVERY_ACCOUNT_ACCESS_SPECS],
  ])('keeps %s on its owner-run isolated verifier', (scriptName, verifier, expectedSpecs) => {
    expect(script(scriptName)).toBe(`node --import tsx ${verifier}`)
    const runner = readFileSync(resolve(root, verifier), 'utf8')
    expect(specPathsIn(runner)).toEqual(expectedSpecs)
    expect(runner).toContain('runOpsE2e(')
    expect(runner).toContain('fixture')
    expect(runner).not.toContain('https://yxsona.com')
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
    const requiredBrowserScripts = Object.keys(packageJson.scripts).filter(name => name.startsWith('test:browser:') && name !== 'test:browser:all' && name !== 'test:browser:ops:jit')
    for (const name of requiredBrowserScripts) expect(all).toContain(`npm run ${name}`)
    expect(all).toContain('npm run test:browser:merchant:overview-journeys')
    expect(all).not.toContain('test:browser:ops:jit')

    const overview = script('test:browser:merchant:overview-journeys')
    expect(overview).toContain('MERCHANT_OVERVIEW_BROWSER_FIXTURE=1')
    expect(overview).toContain('MERCHANT_STUDIO_URL=http://127.0.0.1:4190')
    expect(overview).toContain('--config=dogfood/chatgpt-all-functions')
    expect(overview).toContain('--workers=1')
    expect(overview).not.toContain('https://yxsona.com')
  })

  it('runs subscription and delivery read recovery through a local merchant fixture', () => {
    const command = script('test:browser:merchant:read-recovery')
    expect(specPathsIn(command).sort()).toEqual([...MERCHANT_READ_RECOVERY_SPECS].sort())
    expect(command).toContain('MERCHANT_CATALOG_BROWSER_FIXTURE=1')
    expect(command).toContain('MERCHANT_STUDIO_URL=http://127.0.0.1:4188')
    expect(command).toContain('--workers=1')
  })

  it('runs login and workspace onboarding in an isolated local browser fixture', () => {
    const command = script('test:browser:merchant:login-onboarding')
    expect(specPathsIn(command)).toEqual(MERCHANT_LOGIN_ONBOARDING_SPECS)
    expect(command).toContain('--workers=1')
    expect(command).not.toContain('https://yxsona.com')
  })

  it('runs publish history in its isolated local browser fixture', () => {
    expect(script('test:browser:merchant:publish-history')).toBe('node scripts/run-publish-history-browser-local.mjs')
    const runner = readFileSync(resolve(root, 'scripts/run-publish-history-browser-local.mjs'), 'utf8')
    expect(runner).toContain("'demo/merchant-studio/publish-history.browser.spec.js'")
    expect(runner).toContain("'127.0.0.1'")
    expect(runner).not.toContain('https://yxsona.com')
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

  it('keeps browser config resolution explicit and prevents accidental root config discovery', () => {
    const configs = filesOnDisk(root, name => /^playwright\.config\.[cm]?[jt]s$/u.test(name))
    expect(configs).toEqual([PLAYWRIGHT_CONFIG])
    // Playwright resolves a config directory-only from the process working
    // directory and does not walk upward. The runners inherit the repository
    // root as cwd, which holds no config. Most runners intentionally omit
    // `--config`; the task-queue entrypoint is pinned above as the one explicit
    // dogfood-config consumer.
    expect(configs.some(file => !file.includes('/')), 'a root-level playwright.config.* would change browser config resolution').toBe(false)
  })

  it('records the specs the unused playwright config claims but no browser script runs', () => {
    const configMatched = playwrightCollectedSpecs(root)
    expect(configMatched.size, 'the config matched nothing, so the ledger credit is vacuous').toBeGreaterThan(0)
    expect([...configMatched].filter(file => !file.startsWith(`${DOGFOOD_DIR}/`))).toEqual([])

    const runByBrowserScripts = new Set([...MERCHANT_SPECS, ...MERCHANT_CATALOG_READ_RETRY_SPECS, ...MERCHANT_RECYCLE_BIN_SPECS, ...MERCHANT_COMMERCIAL_PURCHASE_SPECS, ...MERCHANT_STORE_REGISTRATION_SPECS, ...MERCHANT_URL_ROUTE_MATRIX_SPECS, ...MERCHANT_OVERVIEW_JOURNEY_SPECS, ...MERCHANT_READ_RECOVERY_SPECS, ...MERCHANT_LOGIN_ONBOARDING_SPECS, ...MERCHANT_RULES_SPECS, ...OPS_SPECS, ...OPS_COMMERCIAL_SPECS, ...OPS_BENEFIT_BUNDLE_SPECS, ...OPS_REFUND_SPECS, ...LOCAL_MOCKED_STATE_SPECS, ...MERCHANT_TASK_QUEUE_SPECS, ...MERCHANT_IMAGE_GENERATION_SPECS, ...MERCHANT_WORKSPACE_SWITCH_SPECS, ...OPS_MATRIX_SPECS, ...OPS_DESKTOP_STATE_SPECS, ...OPS_ACCOUNT_LABEL_SPECS, ...OPS_ACCOUNT_OWNERSHIP_SPECS, ...OPS_TEMPLATE_SPECS, ...OPS_RULE_UPLOAD_SPECS, ...OPS_PUBLIC_RULE_UPLOAD_SPECS, ...OPS_PRODUCT_IMPORT_SPECS, ...OPS_UNMATCHED_READONLY_SPECS, ...OPS_DELIVERY_READONLY_SPECS, ...OPS_MANUAL_IMPORT_SPECS, ...OPS_MCP_REQUEST_MATRIX_SPECS, ...OPS_MERCHANT_MATRIX_BOOTSTRAP_SPECS, ...OPS_DELIVERY_CONTRACT_LINK_SPECS, ...OPS_DELIVERY_ACCOUNT_ACCESS_SPECS, ...OPS_MERCHANT_PROVISION_SPECS, spec('ops-jit-isolated.spec.js'), spec('ops-members-global-isolated.spec.js')])
    const configOnly = [...configMatched].filter(file => !runByBrowserScripts.has(file)).sort()
    expect(configOnly.length, 'an empty claim list would make this assertion vacuous').toBeGreaterThan(0)
    expect(configOnly).toEqual(CONFIG_ONLY_BROWSER_SPECS)
  })
})
