import { describe, expect, it, vi } from 'vitest'
import {
  buildHttpConnectorConfigs,
  createConfiguredConnector,
  type AccessCredential,
  type CredentialProvider,
  type Platform,
} from '../packages/connectors/src/index.js'
import { API_SELECTOR_BY_OPERATION, PLATFORM_API_SELECTORS } from '../packages/connectors/src/platform-adapters/api-selector.js'

/**
 * Invariant: a platform credential must never appear in a request URL.
 *
 * Evidence for `credential-transport-and-release-env.invariant.ts`. Every
 * request below is built by the signer the *production configuration* produces
 * (`buildHttpConnectorConfigs`, the same function the API and workers call) and
 * dispatched by the real connector through a fetch stub that records the exact
 * URL/body/header triple the platform would receive. Nothing here asserts on
 * source text, and no signer is faked: a hand-written signer that "returns a URL
 * without a token" would prove nothing about what the shipped signers do.
 *
 * Two platform families, two credentials transports, and the read method has to
 * follow the credential:
 *
 *  - Router gateways (JD routerjson, Alibaba TOP, Pinduoduo) sign
 *    `access_token`/`session`, `app_key`/`client_id` and `sign` into one
 *    parameter set. That set has no transport except a form body, so their reads
 *    are POST. The regression being guarded: the set used to travel in the
 *    query string, where the platform gateway, any host proxy, and any
 *    request-URL log or APM span record it verbatim.
 *  - Bearer platforms (xiaohongshu, douyin) send the token in the
 *    `authorization` header and never reach `applySignedRequest`, so their
 *    parameter set is empty and their reads stay GET. Guards the repair's own
 *    overshoot: a POST chosen at the shared call site flipped these two reads to
 *    a bodyless POST — no security benefit (their token was never in the URL)
 *    and an unverified wire change on a live read path.
 *
 * Both directions are asserted for each family: a correct dispatch is admitted
 * (the read resolves and the credential is on the request where the platform
 * expects it) *and* the URL carries no credential. A test that only proved the
 * first would go red for "the read broke" and certify the invariant for the
 * wrong reason.
 */
const credentials: CredentialProvider = {
  kind: 'test',
  async resolve(): Promise<AccessCredential> { return { accessToken: 'live-platform-access-token', refreshToken: 'live-platform-refresh-token' } },
  async store() { return { accountId: 'acct-transport', credentialRef: 'vault://transport' } },
  async revoke() {},
}

const context = { workspaceId: 'ws-transport', accountId: 'acct-transport', credentialRef: 'vault://transport' }

const routerPlatforms = ['jd', 'taobao', 'pinduoduo'] as const
const bearerPlatforms = ['xiaohongshu', 'douyin'] as const
const allPlatforms = [...routerPlatforms, ...bearerPlatforms] as const

/** Configuration prefix per platform, from the platform's own key namespace. */
const configPrefix: Record<Platform, string> = { jd: 'JD', taobao: 'TAOBAO', tmall: 'TMALL', pinduoduo: 'PDD', xiaohongshu: 'XHS', douyin: 'DOUYIN' }

/** Production-shaped env for the three router gateways, everything but the platform's own keys omitted. */
function routerEnvironment(platform: (typeof routerPlatforms)[number]): Record<string, string> {
  const prefix = configPrefix[platform]
  const host = `https://${platform}.transport.test/api`
  return {
    [`${prefix}_CLIENT_ID`]: `${platform}-app`,
    [`${prefix}_CLIENT_SECRET`]: `${platform}-secret`,
    [`${prefix}_OAUTH_AUTHORIZE_URL`]: `https://${platform}.transport.test/authorize`,
    [`${prefix}_OAUTH_TOKEN_URL`]: `https://${platform}.transport.test/token`,
    [`${prefix}_API_BASE_URL`]: host,
    [`${prefix}_SYNC_PATH`]: '/products',
    [`${prefix}_CREATE_PATH`]: '/products/create',
    [`${prefix}_UPDATE_PATH`]: '/products/update',
    [`${prefix}_QUERY_PATH`]: '/publish/status',
    // The selector table is what the signer resolves each operation from; it is
    // never read off the request URL (see platform-adapters/api-selector.ts).
    // One key per selector the signer declares, so `upload_media` is covered by
    // the sweep below rather than silently skipped.
    [`${prefix}_SYNC_METHOD`]: { jd: 'jd.product.sync', taobao: 'taobao.item.seller.get', pinduoduo: 'pdd.goods.detail' }[platform],
    [`${prefix}_CREATE_METHOD`]: { jd: 'jingdong.ware.create', taobao: 'taobao.item.add', pinduoduo: 'pdd.goods.add' }[platform],
    [`${prefix}_UPDATE_METHOD`]: { jd: 'jingdong.ware.update', taobao: 'taobao.item.update', pinduoduo: 'pdd.goods.update' }[platform],
    [`${prefix}_QUERY_METHOD`]: { jd: 'jingdong.ware.status.get', taobao: 'taobao.item.get', pinduoduo: 'pdd.goods.detail.get' }[platform],
    [`${prefix}_MEDIA_METHOD`]: { jd: 'jingdong.ware.image.upload', taobao: 'taobao.item.img.upload', pinduoduo: 'pdd.goods.image.upload' }[platform],
    // Only jd and taobao read an operation switch; the pinduoduo switches are
    // declared but wired to nothing, and `buildHttpConnectorConfigs` refuses an
    // explicit `true` on them rather than pretending they did something.
    ...(platform === 'pinduoduo' ? {} : { [`${prefix}_AUTH_ENABLED`]: 'true', [`${prefix}_READ_ENABLED`]: 'true', [`${prefix}_WRITE_ENABLED`]: 'true' }),
  }
}

/**
 * Production-shaped env for the two bearer platforms. No `*_ENABLED` key is
 * set: `XHS_*_ENABLED` is declared but read by nothing, and
 * `buildHttpConnectorConfigs` refuses an explicit `true` on it rather than
 * pretending it did something.
 */
function bearerEnvironment(platform: (typeof bearerPlatforms)[number]): Record<string, string> {
  const prefix = configPrefix[platform]
  const host = `https://${platform}.transport.test/api`
  return {
    [`${prefix}_CLIENT_ID`]: `${platform}-app`,
    [`${prefix}_CLIENT_SECRET`]: `${platform}-secret`,
    [`${prefix}_OAUTH_AUTHORIZE_URL`]: `https://${platform}.transport.test/authorize`,
    [`${prefix}_OAUTH_TOKEN_URL`]: `https://${platform}.transport.test/token`,
    [`${prefix}_API_BASE_URL`]: host,
    [`${prefix}_SYNC_PATH`]: '/products',
    [`${prefix}_CREATE_PATH`]: '/products/create',
    [`${prefix}_UPDATE_PATH`]: '/products/update',
    [`${prefix}_QUERY_PATH`]: '/publish/status',
  }
}

/** Credential parameter each router gateway signs into the parameter set. */
const credentialParameter: Record<(typeof routerPlatforms)[number], string> = { jd: 'access_token', taobao: 'session', pinduoduo: 'access_token' }

interface SentRequest { method: string; url: string; body: string | null; authorization: string | null }

function recordingFetch(seen: SentRequest[], payload: unknown) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    // The real fetch constructor is used rather than a stub that ignores `init`:
    // a signed body on a bodyless method throws here, before any network call.
    const request = new Request(String(url), init)
    seen.push({
      method: request.method,
      url: request.url,
      body: typeof init?.body === 'string' ? init.body : null,
      authorization: request.headers.get('authorization'),
    })
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  })
}

const product = { remoteId: 'transport-read-1', title: 'transport product', description: '', price: 10, stock: 1, sku: [], images: [], category: '', attributes: {}, platformFields: {}, observedAt: new Date().toISOString() }

function configured(platform: Platform) {
  const built = buildHttpConnectorConfigs(routerPlatforms.includes(platform as (typeof routerPlatforms)[number])
    ? routerEnvironment(platform as (typeof routerPlatforms)[number])
    : bearerEnvironment(platform as (typeof bearerPlatforms)[number]))
  return built.allConfigs[platform]
}

describe('platform credentials never travel in the request URL', () => {
  it('sweeps every operation and every signer of the credential-carrying chokepoint', async () => {
    // "Covered" has to mean the whole chokepoint, not the sample that happened
    // to be written down: the operation list above is derived from the selector
    // table, and the earlier hand-written list omitted `upload_media` — so four
    // of the five operations a router signer can be asked to sign were certified
    // and one was not. These two equalities are what make the sweep exhaustive
    // rather than merely larger, and they are read off the production
    // configuration, so a new operation or a new credential-carrying signer
    // enlarges the sweep by existing.
    const operations = Object.keys(API_SELECTOR_BY_OPERATION)
    expect([...new Set(Object.values(API_SELECTOR_BY_OPERATION))].sort(), 'the operations swept are all the selectors a router signer declares')
      .toEqual([...PLATFORM_API_SELECTORS].sort())
    expect(operations).toContain('upload_media')

    const declaresCredential = (platform: Platform) => configured(platform)?.signer?.signedParametersCarryCredential === true
    expect(allPlatforms.filter(declaresCredential).sort(), 'exactly the router signers carry the credential in their signed set')
      .toEqual([...routerPlatforms].sort())
    // The other declaration that marks a router signer, checked against the same
    // input so the two can never disagree about which signers need a body.
    for (const platform of routerPlatforms) expect(configured(platform)?.signer?.requiredApiSelectors?.length, `${platform} declares its selectors`).toBeGreaterThan(0)
    for (const platform of bearerPlatforms) expect(configured(platform)?.signer?.requiredApiSelectors, `${platform} declares none`).toBeUndefined()
  })

  it.each(routerPlatforms)('%s reads are POSTed with the credential in the signed body', async platform => {
    const built = buildHttpConnectorConfigs(routerEnvironment(platform))
    const config = built.allConfigs[platform]
    expect(config?.signer?.kind, `${platform} builds a platform signer from the production environment`).toBe('platform')
    expect(config?.signer?.signedParametersCarryCredential, `${platform} signer folds the credential into its signed parameter set`).toBe(true)
    expect(config?.api.methods?.sync, `${platform} resolves its read selector from configuration`).toBeTruthy()

    const seen: SentRequest[] = []
    const fetchMock = recordingFetch(seen, { items: [product] })
    const connector = createConfiguredConnector(platform as Platform, {
      config: { ...config!, mapProducts: () => [product] },
      credentials, allowTestCredentials: true, allowTestAdapters: true, fetch: fetchMock,
    })
    await expect(connector.syncProducts(context, { value: 'cursor-page-2' })).resolves.toMatchObject({ items: [{ remoteId: 'transport-read-1' }], source: 'official_api' })

    expect(seen).toHaveLength(1)
    const request = seen[0]!
    expect(request.method).toBe('POST')
    // The whole URL, not just the path: a credential smuggled into the query is
    // what the invariant forbids, and it is what the previous read path did.
    const url = new URL(request.url)
    expect(url.search, `${platform} read URL must carry no query string at all`).toBe('')
    expect(request.url).not.toContain('live-platform-access-token')
    expect(request.url).not.toContain('sign=')
    // The credential really is on this request — it travels in the body.
    const body = new URLSearchParams(request.body ?? '')
    expect(body.get(credentialParameter[platform])).toBe('live-platform-access-token')
    expect(body.get('cursor')).toBe('cursor-page-2')
    expect(body.get('sign')).toMatch(/^[A-F0-9]{32,64}$/)
  })

  it.each(routerPlatforms)('%s signs every operation without touching the URL', async platform => {
    // The chokepoint is shared, so the sweep covers the sibling operations too:
    // one signer that only keeps the credential out of the URL "for the sync
    // call" is exactly the asymmetry this invariant exists to prevent. The
    // operation list is the selector table itself, so an operation added there
    // cannot be left unswept — `upload_media` was missing from the hand-written
    // list this replaces, which is how a shared chokepoint comes to be certified
    // on four fifths of its callers.
    const built = buildHttpConnectorConfigs(routerEnvironment(platform))
    const signer = built.allConfigs[platform]!.signer!
    expect(signer.signedParametersCarryCredential, `${platform} signer declares the credential in its signed set`).toBe(true)
    const operations = Object.keys(API_SELECTOR_BY_OPERATION) as Array<keyof typeof API_SELECTOR_BY_OPERATION>
    expect(operations).toContain('upload_media')
    for (const operation of operations) {
      const request = {
        method: 'POST',
        url: `https://${platform}.transport.test/api/products?cursor=page-2&updated_since=2026-01-01T00:00:00Z`,
        headers: {} as Record<string, string>,
        body: JSON.stringify({ title: 'transport product' }),
        platform: platform as Platform,
        operation,
        credential: { accessToken: 'live-platform-access-token' },
      }
      await signer.sign(request)
      expect(new URL(request.url).search, `${platform} ${operation} must not sign anything into the URL`).toBe('')
      expect(request.url).not.toContain('live-platform-access-token')
      const body = new URLSearchParams(request.body as string)
      expect(body.get(credentialParameter[platform]), `${platform} ${operation} keeps the credential in the body`).toBe('live-platform-access-token')
      expect(body.get('sign'), `${platform} ${operation} is really signed`).toMatch(/^[A-F0-9]{32,64}$/)
      // The caller's own paging parameters travel with it.
      expect(body.get('cursor')).toBe('page-2')
    }
  })

  it.each(bearerPlatforms)('%s reads stay GET with the credential in the authorization header', async platform => {
    // The range overreach this pins: these two signers never call
    // `applySignedRequest` (they are `createBearerSigner`, which returns an empty
    // parameter set), so the credential was never in the URL and moving the read
    // to POST bought no security — it only changed the wire shape of a live read
    // path that no test covered. A bodyless POST with no content-type is not the
    // shape either platform was ever called with.
    const built = buildHttpConnectorConfigs(bearerEnvironment(platform))
    const config = built.allConfigs[platform]
    expect(config?.signer?.kind, `${platform} builds a platform signer from the production environment`).toBe('platform')
    expect(config?.signer?.signedParametersCarryCredential, `${platform} signer carries the credential in a header, not in a signed parameter set`).toBeFalsy()
    expect(config?.signer?.requiredApiSelectors, `${platform} resolves no router API selector`).toBeUndefined()

    const seen: SentRequest[] = []
    const fetchMock = recordingFetch(seen, { items: [product] })
    const connector = createConfiguredConnector(platform as Platform, {
      config: { ...config!, mapProducts: () => [product] },
      credentials, allowTestCredentials: true, allowTestAdapters: true, fetch: fetchMock,
    })
    await expect(connector.syncProducts(context, { value: 'cursor-page-2' })).resolves.toMatchObject({ items: [{ remoteId: 'transport-read-1' }], source: 'official_api' })

    expect(seen).toHaveLength(1)
    const request = seen[0]!
    expect(request.method, `${platform} reads keep the GET their platform is called with`).toBe('GET')
    expect(request.body, `${platform} GET carries no body`).toBeNull()
    // The admission side: the credential is really on the request, in the header
    // this platform reads it from. Without this, `method: 'GET'` would also pass
    // for a request that dropped the credential entirely.
    expect(request.authorization).toBe('Bearer live-platform-access-token')
    // ...and the URL is still credential-free. The caller's paging parameter is
    // the positive control: the query is genuinely used, it just carries no
    // credential — so an empty-URL assertion cannot be satisfied by accident.
    const url = new URL(request.url)
    expect(url.searchParams.get('cursor')).toBe('cursor-page-2')
    expect(request.url).not.toContain('live-platform-access-token')
    expect(request.url).not.toContain('sign=')
  })

  it.each(allPlatforms)('%s dispatches its read with the transport its credential actually needs', async platform => {
    // The family-independent statement of the invariant, and the one that fails
    // for the right reason under either mutation: the credential's location on
    // the wire is observed (not assumed), and the method has to match it.
    const config = configured(platform)
    const carriesCredentialInParams = config?.signer?.signedParametersCarryCredential === true

    const seen: SentRequest[] = []
    const connector = createConfiguredConnector(platform as Platform, {
      config: { ...config!, mapProducts: () => [product] },
      credentials, allowTestCredentials: true, allowTestAdapters: true, fetch: recordingFetch(seen, { items: [product] }),
    })
    await expect(connector.syncProducts(context, { value: 'cursor-page-2' })).resolves.toMatchObject({ source: 'official_api' })

    const request = seen[0]!
    // Where the credential is on this wire, read off the request itself.
    const inBody = carriesCredentialInParams ? new URLSearchParams(request.body ?? '').get(credentialParameter[platform as (typeof routerPlatforms)[number]]) ?? null : null
    const inHeader = request.authorization?.replace(/^Bearer /u, '') ?? null
    expect(carriesCredentialInParams ? inBody : inHeader, `${platform} carries the credential in exactly one place`).toBe('live-platform-access-token')
    // A credential set with no URL transport needs a body; one that travels in a
    // header has nothing to put in a body. So the method is not a free choice.
    expect(request.method, `${platform} method must be ${carriesCredentialInParams ? 'POST (the signed set has no other transport)' : 'GET (there is no signed set to carry)'}`)
      .toBe(carriesCredentialInParams ? 'POST' : 'GET')
    expect(request.url).not.toContain('live-platform-access-token')
  })
})
