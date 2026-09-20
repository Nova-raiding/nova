import { describe, expect, it, vi } from 'vitest'
import {
  buildHttpConnectorConfigs,
  createConfiguredConnector,
  type AccessCredential,
  type CredentialProvider,
  type HttpConnectorConfig,
  type Platform,
} from '../packages/connectors/src/index.js'
import { PLATFORM_READ_METHODS, readMethodAllowed } from '../infra/protected/attest-capability-evidence.mjs'

/**
 * The protected attester's read-transport policy, pinned to the implementation
 * it verifies.
 *
 * The decision "does this platform's read carry a body?" belongs to one runtime
 * point: `HttpPlatformConnector.syncProducts` asks the configured
 * `RequestSigner.signedParametersCarryCredential` and dispatches the read
 * accordingly. `infra/protected/attest-capability-evidence.mjs` cannot consume
 * that point — it is the root-owned, digest-pinned verifier installed outside
 * the repository, and a verifier that reads the code under attestation cannot
 * refuse it — so it declares the family policy itself
 * (`PLATFORM_READ_METHODS`). This file is what keeps the declaration honest: it
 * drives a real read through the signer the *production* configuration builds
 * (`buildHttpConnectorConfigs`, the same function the API and workers call) for
 * all six platforms, records the method the connector actually dispatches, and
 * fails if the table stops agreeing with the wire.
 *
 * That agreement is not cosmetic. The sibling repo-side gate
 * (`tests/platform-transcript-gate.ts`) required a POST for every exchange and
 * silently refused the truthful xiaohongshu/douyin record — the same defect the
 * attester had, still live in the gate because nothing pinned the two together.
 * The policy now has one definition and this test proves which definition is
 * right.
 *
 * The asymmetry the table encodes is deliberate and is asserted here in both
 * directions: a credential-carrying signer's read may never be bodyless (that is
 * the URL-leak regression), and a bearer signer's read is GET (demanding a body
 * there rejected the only truthful transcript those two platforms can produce).
 */
const prefix: Record<Platform, string> = { jd: 'JD', taobao: 'TAOBAO', tmall: 'TMALL', pinduoduo: 'PDD', xiaohongshu: 'XHS', douyin: 'DOUYIN' }
const routerPlatforms: readonly Platform[] = ['jd', 'taobao', 'tmall', 'pinduoduo']
const bearerPlatforms: readonly Platform[] = ['xiaohongshu', 'douyin']
const allPlatforms: readonly Platform[] = [...routerPlatforms, ...bearerPlatforms]

/**
 * Production-shaped environment for one platform. Only the keys the connector
 * configuration reads are set: the `*_ENABLED` operation switches are wired for
 * jd and taobao alone (tmall is controlled by the taobao switches, and the
 * pinduoduo switches are declared but read by nothing — an explicit `true` on
 * either is refused rather than accepted as a no-op).
 */
function environment(platform: Platform): Record<string, string> {
  const key = prefix[platform]
  const host = `https://${platform}.read-transport.test/api`
  const source: Record<string, string> = {
    [`${key}_CLIENT_ID`]: `${platform}-app`,
    [`${key}_CLIENT_SECRET`]: `${platform}-secret`,
    [`${key}_OAUTH_AUTHORIZE_URL`]: `https://${platform}.read-transport.test/authorize`,
    [`${key}_OAUTH_TOKEN_URL`]: `https://${platform}.read-transport.test/token`,
    [`${key}_API_BASE_URL`]: host,
    [`${key}_SYNC_PATH`]: '/products',
    [`${key}_CREATE_PATH`]: '/products/create',
    [`${key}_UPDATE_PATH`]: '/products/update',
    [`${key}_QUERY_PATH`]: '/publish/status',
  }
  if (routerPlatforms.includes(platform)) {
    for (const selector of ['SYNC', 'CREATE', 'UPDATE', 'QUERY', 'MEDIA']) source[`${key}_${selector}_METHOD`] = `${platform}.${selector.toLowerCase()}`
    if (platform === 'jd' || platform === 'taobao') {
      source[`${key}_AUTH_ENABLED`] = 'true'
      source[`${key}_READ_ENABLED`] = 'true'
      source[`${key}_WRITE_ENABLED`] = 'true'
    }
  }
  return source
}

const credentials: CredentialProvider = {
  kind: 'test',
  async resolve(): Promise<AccessCredential> { return { accessToken: 'read-transport-token', refreshToken: 'read-transport-refresh' } },
  async store() { return { accountId: 'acct-read-transport', credentialRef: 'vault://read-transport' } },
  async revoke() {},
}

const context = { workspaceId: 'ws-read-transport', accountId: 'acct-read-transport', credentialRef: 'vault://read-transport' }
const product = { remoteId: 'read-transport-1', title: 'read transport product', description: '', price: 1, stock: 1, sku: [], images: [], category: '', attributes: {}, platformFields: {}, observedAt: new Date().toISOString() }

/** Dispatches one read through the connector the production configuration built
 * and returns the method the platform would have received. */
async function dispatchedReadMethod(platform: Platform, config: HttpConnectorConfig | undefined) {
  const seen: string[] = []
  const connector = createConfiguredConnector(platform, {
    ...(config ? { config: { ...config, mapProducts: () => [product] } } : {}),
    credentials,
    allowTestCredentials: true,
    allowTestAdapters: true,
    fetch: vi.fn(async (_url: string | URL, init?: RequestInit) => {
      seen.push(String(init?.method))
      return new Response(JSON.stringify({ items: [product] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as never,
  })
  await connector.syncProducts(context, undefined)
  expect(seen, `${platform} dispatched exactly one read`).toHaveLength(1)
  return seen[0]!
}

describe('the protected read-transport policy agrees with the shipped signers', () => {
  it.each(allPlatforms)('%s dispatches the read its family policy admits', async platform => {
    const built = buildHttpConnectorConfigs(environment(platform))
    const config = built.allConfigs[platform]
    expect(config, `${platform} builds a configuration from the production environment`).toBeDefined()
    const carries = config!.signer?.signedParametersCarryCredential === true
    expect(carries, `${platform} family`).toBe(routerPlatforms.includes(platform))

    const method = await dispatchedReadMethod(platform, config)
    // The wire shape is the one the evidence policy admits, and the policy says
    // something: it is not satisfied by every method, which would make the
    // attestation check unfireable.
    expect(readMethodAllowed(platform, method), `${platform} read method ${method} is admitted by the evidence policy`).toBe(true)
    expect(PLATFORM_READ_METHODS[platform], `${platform} policy is declared`).toBeDefined()

    if (carries) {
      expect(method, `${platform} carries the credential in its signed set, so its read needs a body`).toBe('POST')
      expect(readMethodAllowed(platform, 'GET'), `${platform} may not record a bodyless read`).toBe(false)
    } else {
      expect(method, `${platform} keeps the credential in authorization, so its read stays the GET it is called with`).toBe('GET')
      // The tolerated body-carrying shape: the credential is not in the parameter
      // set either way, so refusing it would reject evidence without removing any
      // exposure.
      expect(readMethodAllowed(platform, 'POST'), `${platform} may record the body-carrying shape`).toBe(true)
    }
  })

  it('fails closed for a platform the policy does not name', () => {
    // The six-platform matrix is asserted before any transcript is read, so an
    // unnamed platform can only reach the policy by a defect. It must not inherit
    // the bearer tolerance.
    expect(readMethodAllowed('unknown-platform', 'GET')).toBe(false)
    expect(readMethodAllowed('unknown-platform', 'POST')).toBe(true)
  })
})
