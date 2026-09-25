/**
 * Credential-free manual operations mode — safety invariants.
 *
 * The failure this exists for: manual mode (`PLATFORM_OPERATIONS_MODE=manual`)
 * exists precisely because no platform OAuth is wired, so the only thing that
 * stops a manual store record from being mistaken for an authorised connection
 * is a handful of facts spread across four files. Each of those facts is one
 * careless edit away from turning "registered by operations" into "has a real
 * grant": a `vault://` credential ref the provider would resolve, a
 * `token_state` that reads as `connected`, a record that leaks into the
 * merchant `tools/list`, or a console label that shows 真实授权. None of those
 * edits would fail an existing behavioural test until a merchant is already
 * acting on a store nobody authorised.
 *
 * This is a static, source-level guard (same shape as
 * `tests/ops-component-architecture.test.ts` and
 * `tests/merchant-dogfood-retirements.test.ts`) so it fails at the edit, not
 * after it ships. Its assertions deliberately pin the *invariant*, not the
 * prose around it: the label values 真实授权 only has to belong to `connected`.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8')
function mcpHandlerSource(method: string): string {
  const server = read('apps/api/src/server.ts')
  const files = ['server.ts', ...readdirSync(resolve(root, 'apps/api/src'))
    .filter(name => /^mcp-.*handlers\.ts$/u.test(name) && server.includes(`'./${name.slice(0, -3)}.js'`))]
  const matches = files.map(name => read(`apps/api/src/${name}`)).filter(source => source.includes(`case '${method}':`))
  expect(matches, `${method} needs exactly one dispatch handler`).toHaveLength(1)
  return matches[0]!
}

const METHOD = 'ops.platform.store.record.create'
const NO_CREDENTIAL_REF_PREFIX = 'manual-store-record:no-credential:'
const NON_AUTHORISED_TOKEN_STATE = 'manually_registered'

/**
 * Slice a source region between two unique markers. Boundaries are marker text
 * rather than brace balancing because the API handler carries prose comments
 * with backticks and apostrophes inside the block we want to read.
 */
function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  expect(start, `missing source marker: ${startMarker}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endMarker, start + startMarker.length)
  expect(end, `missing end marker: ${endMarker}`).toBeGreaterThan(start)
  return source.slice(start, end)
}

/** Parse a `key: "value"` map literal's entries, ignoring any cast suffix. */
function stringMapEntries(block: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const match of block.matchAll(/([A-Za-z_][A-Za-z0-9_]*):\s*(["'])([^"']*)\2/gu)) {
    const key = match[1]
    const value = match[3]
    if (key && value !== undefined) entries.set(key, value)
  }
  return entries
}

describe('manual store record writes no credential', () => {
  const service = read('packages/application/src/service.ts')

  it('uses an explicit non-credential reference, never a vault path', () => {
    const factory = sliceBetween(service, 'export function manualStoreRecordCredentialRef(', '\n}')
    // The provider treats `vault://` as authoritative and reads that exact
    // path, so a placeholder shaped like a vault reference could shadow a real
    // secret. The scheme must stay non-resolvable.
    expect(factory).not.toContain('vault://')
    expect(factory).toContain('`' + NO_CREDENTIAL_REF_PREFIX + '${accountId}`')
  })

  it('writes that reference and no token, secret or bearer value', () => {
    const register = sliceBetween(service, '\n  registerManualPlatformAccount(', '\n  setPlatformAccountAlias(')
    expect(register).toContain('credentialRef: manualStoreRecordCredentialRef(id)')
    expect(register).not.toContain('vault://')
    for (const secret of ['accessToken', 'refreshToken', 'access_token', 'refresh_token', 'clientSecret', 'client_secret', 'password', 'cookie', 'Bearer ']) {
      expect(register, `${secret} must never appear on the manual registration path`).not.toContain(secret)
    }
  })

  it('is the only writer of the non-authorised token state', () => {
    expect(service).toContain(`export const MANUAL_STORE_RECORD_TOKEN_STATE = '${NON_AUTHORISED_TOKEN_STATE}' as const`)
    // One assignment means one code path can create this state; a second writer
    // is how a fabricated-looking record would enter without review.
    expect(service.match(/tokenState: MANUAL_STORE_RECORD_TOKEN_STATE/gu) ?? []).toHaveLength(1)
  })
})

describe('manual store record is never marked as authorised', () => {
  const service = read('packages/application/src/service.ts')
  const register = sliceBetween(service, '\n  registerManualPlatformAccount(', '\n  setPlatformAccountAlias(')

  it('writes the non-authorised token state and never `connected`', () => {
    expect(NON_AUTHORISED_TOKEN_STATE).not.toBe('connected')
    expect(register).toContain('tokenState: MANUAL_STORE_RECORD_TOKEN_STATE')
    expect(register).not.toContain("tokenState: 'connected'")
  })

  it('leaves every authorization marker absent', () => {
    // These are the fields downstream "is this authorized?" readers look at.
    // Writing any of them would hand a publish job a fabrication to pin to.
    for (const marker of ['lastAuthorizedAt', 'grantedScopes', 'accessTokenExpiresAt', 'credentialRefreshable', 'authRevision']) {
      expect(register, `${marker} would fabricate an authorization on a credential-free record`).not.toContain(marker)
    }
  })

  it('refuses to downgrade a live authorization into a manual record', () => {
    expect(register).toContain('PLATFORM_ACCOUNT_ALREADY_AUTHORIZED')
  })

  it('reports the connection honestly instead of a receipt', () => {
    const handler = sliceBetween(mcpHandlerSource(METHOD), `case '${METHOD}': {`, "case 'ops.brand-units.summary': {")
    expect(handler).toContain("mode: 'manual_store_record'")
    expect(handler).toContain('credential_free: true')
    expect(handler).toContain('authorization_receipt: null')
    expect(handler).not.toContain('vault://')
  })
})

describe('manual registration stays platform-operations only', () => {
  it('is refused for a merchant principal by the operations-role guard', () => {
    const handler = sliceBetween(mcpHandlerSource(METHOD), `case '${METHOD}': {`, "case 'ops.brand-units.summary': {")
    expect(handler).toContain("requireOperationsRole(req, ['platform_ops'])")
  })

  it('is authorized on the platform workbench and platform scope, never workspace-scoped', () => {
    const authz = read('packages/contracts/src/authz.ts')
    const policy = authz.split('\n').find(line => line.includes(`'${METHOD}'`))
    expect(policy, `${METHOD} must stay in the versioned authorization matrix`).toBeDefined()
    expect(policy).toContain("'platform'")
    expect(policy).toContain('allow_and_deny')
    expect(policy).not.toContain("'workspace'")
  })

  it('can never be admitted under a shadow-only authorization rollout', () => {
    const authorizationRuntime = read('apps/api/src/authorization-policy-runtime.ts')
    const enforced = sliceBetween(authorizationRuntime, 'const alwaysEnforcedMcpMethods = new Set([', '])')
    expect(enforced).toContain(`'${METHOD}'`)
  })

  it('is filtered out of every merchant tools/list', () => {
    const bridge = read('apps/plugin/mcp/bridge.mjs')
    // The merchant bridge admits only methods that do not start with `ops.`.
    // Renaming the method out of that prefix would expose it to merchants.
    expect(bridge).toContain("const isMerchantTool = name => !name.startsWith('ops.')")
    expect(METHOD.startsWith('ops.')).toBe(true)
    const descriptor = sliceBetween(read('packages/contracts/src/mcp.ts'), `method: '${METHOD}'`, 'params: params(')
    expect(descriptor).toContain('Platform operations only.')
    expect(descriptor).toContain(`token_state=${NON_AUTHORISED_TOKEN_STATE}`)
    expect(descriptor).toContain('Hidden from every merchant surface.')
  })
})

describe('ops console presents the manual state distinctly from real authorization', () => {
  // READ-ONLY dependency: `storeAuthorizationStateLabel` in
  // `StoreDirectorySection.tsx` is owned by another change in flight. Only the
  // invariant is asserted here — that 真实授权 belongs to `connected` alone —
  // never the exact copy chosen for `manually_registered`, so a wording change
  // there cannot make this guard fail for the wrong reason.
  const directory = read('apps/ops-console/src/components/stores/StoreDirectorySection.tsx')

  it('labels every authorization state instead of falling through to "unknown"', () => {
    const block = sliceBetween(directory, 'export function storeAuthorizationStateLabel(', '\n}')
    const labels = stringMapEntries(block)
    expect(labels.get('connected')).toContain('真实授权')
    expect(labels.get(NON_AUTHORISED_TOKEN_STATE), 'the manual state needs its own honest label, not the unknown fallback').toBeTruthy()
    // Exactly one state may claim real authorization.
    expect([...labels.entries()].filter(([, value]) => value.includes('真实授权')).map(([key]) => key)).toEqual(['connected'])
    expect(labels.get(NON_AUTHORISED_TOKEN_STATE)).not.toContain('真实授权')
  })
})

describe('the manual still forbids the routes around the missing authorization', () => {
  const manual = read('docs/manual-six-platform-operations.md')

  it.each([
    '不向商家索取平台密码、Cookie、短信验证码、access token 或浏览器会话。',
    '不把运营人员浏览器 Cookie 导入 Store Nova。',
    '不绕过登录墙、验证码、风控或平台访问限制。',
    '不把截图、口头确认或人工登记伪装成平台 API 回执。',
    '没有平台真实回执时，发布包不得包含伪造的 `publish-receipt.json`。',
    '人工发布不得直接写成 `platform_verified` 或自动化 `published`。',
    '不要把平台后台密码或验证码复制到 Store Nova、ChatGPT、工单或审计备注中。',
    '没有在系统中保存密码、Cookie、验证码或 token',
  ])('still states: %s', prohibition => {
    expect(manual).toContain(prohibition)
  })

  it('documents the registration method as credential-free and non-authorising', () => {
    expect(manual).toContain(`token_state=${NON_AUTHORISED_TOKEN_STATE}`)
    expect(manual).toContain('不写任何凭据、scope 或平台回执')
  })
})
