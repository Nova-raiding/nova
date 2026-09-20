import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { buildHttpConnectorConfigs, buildHttpConnectorConfigsFromStructured } from './config.js'
import { createConfiguredConnector } from './index.js'
import { PLATFORM_API_SELECTORS } from './platform-adapters/api-selector.js'
import { createAlibabaTopSigner } from './platform-adapters/alibaba-top.js'
import { createJdSigner } from './platform-adapters/jd.js'
import { createPinduoduoSigner } from './platform-adapters/pinduoduo.js'
import { validateConnectorReadiness } from './readiness.js'
import type { CapabilityEvidence, CapabilityName } from './capability-evidence.js'
import type { AccessCredential, ConnectorContext, HttpConnectorConfig, Platform } from './types.js'

/**
 * A router gateway (JD routerjson, Alibaba TOP, Pinduoduo) selects the platform
 * API with a request parameter, not with the URL path. The selector therefore
 * lives in `api.methods`, and a configuration that omits it used to be admitted
 * by every gate — readiness, `/readyz`, the ECS preflight — and then fail every
 * sync/create/update/query/upload_media call with a terminal `NOT_CONFIGURED`
 * and a dead-letter entry naming only `api.methods.create`.
 *
 * These tests pin the two halves that make that impossible: the incomplete
 * configuration is refused at admission, and the complete one really does sign
 * every operation.
 */

const requiredCapabilities: readonly CapabilityName[] = [
  'authorize', 'refresh', 'read', 'full_sync', 'incremental_sync', 'create', 'update', 'query_status', 'revoke', 'media_upload',
]

function capabilityEvidenceFor(platform: Platform, verifiedAt: string): CapabilityEvidence[] {
  return requiredCapabilities.map(capability => ({
    platform, capability, state: 'test_e2e' as const,
    evidenceRef: `artifact://${platform}/${capability}`, verifiedBy: 'platform-qa', verifiedAt,
  }))
}

const jdSelectors = {
  JD_SYNC_METHOD: 'jingdong.ware.search',
  JD_CREATE_METHOD: 'jingdong.ware.create',
  JD_UPDATE_METHOD: 'jingdong.ware.update',
  JD_QUERY_METHOD: 'jingdong.ware.status.get',
  JD_MEDIA_METHOD: 'jingdong.ware.image.upload',
} as const

/**
 * The configuration a credentialed, canary-verified JD sync needs. Every gate
 * other than the API selectors is satisfied: production paths, mapping and
 * media evidence, a signed capability document and the platform switches.
 */
function signedJdSource(selectors: Record<string, string> = {}) {
  const verifiedAt = new Date(Date.now() - 60_000).toISOString()
  const source: Record<string, string> = {
    NODE_ENV: 'production', RELEASE_ID: 'release-1', RELEASE_GIT_SHA: 'a'.repeat(40), RELEASE_MANIFEST_SHA256: 'b'.repeat(64), RELEASE_IMAGE_SET_DIGEST: `sha256:${'c'.repeat(64)}`,
    JD_AUTH_ENABLED: 'true', JD_READ_ENABLED: 'true', JD_WRITE_ENABLED: 'true',
    JD_APP_KEY: 'jd-app', JD_APP_SECRET: 'jd-secret',
    JD_OAUTH_AUTHORIZE_URL: 'https://jd.test/authorize', JD_OAUTH_TOKEN_URL: 'https://jd.test/token', JD_API_BASE_URL: 'https://jd.test/api',
    JD_SYNC_PATH: '/products', JD_CREATE_PATH: '/products/create', JD_UPDATE_PATH: '/products/update', JD_QUERY_PATH: '/products/status',
    JD_MEDIA_UPLOAD_PATH: '/media/upload', JD_MEDIA_ID_PATH: 'data.media_id',
    JD_MEDIA_UPLOAD_EVIDENCE_VERSION: 'media-v1', JD_MEDIA_UPLOAD_EVIDENCE_REF: 'artifact://production/jd/media', JD_MEDIA_UPLOAD_EVIDENCE_VERIFIED_BY: 'platform-qa', JD_MEDIA_UPLOAD_EVIDENCE_VERIFIED_AT: verifiedAt,
    JD_MAPPING_EVIDENCE_VERSION: 'mapping-v1', JD_MAPPING_EVIDENCE_REF: 'artifact://production/jd/mapping', JD_MAPPING_EVIDENCE_VERIFIED_BY: 'platform-qa', JD_MAPPING_EVIDENCE_VERIFIED_AT: verifiedAt,
    ...selectors,
  }
  const capabilities = Object.fromEntries(requiredCapabilities.map(capability => [capability, {
    state: 'production_canary', evidence_ref: `artifact://production/jd/${capability}#${'a'.repeat(64)}`, verified_by: 'platform-qa', verified_at: verifiedAt, api_version: 'v1', scope: 'item.read',
  }]))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const document: Record<string, unknown> = {
    schema_version: '1', release_id: 'release-1', release_git_sha: source.RELEASE_GIT_SHA, manifest_sha256: source.RELEASE_MANIFEST_SHA256,
    image_set_digest: source.RELEASE_IMAGE_SET_DIGEST, deployment_nonce: 'deployment_nonce_abcdefghijklmnop', key_id: 'release-key',
    environment: 'production', simulated: false, platforms: [{ platform: 'jd', application_id: 'jd-app', test_store_id: 'jd-store', capabilities }],
  }
  document.signature_base64 = sign(null, Buffer.from(canonical(document)), privateKey).toString('base64')
  return { source, trust: { documentJson: JSON.stringify(document), publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), trustedKeyId: 'release-key' } }
}

const compare = ([left]: [string, unknown], [right]: [string, unknown]) => left < right ? -1 : left > right ? 1 : 0
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'signature_base64').sort(compare).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

const credentials = {
  kind: 'external' as const,
  async resolve(): Promise<AccessCredential | undefined> {
    return { accessToken: 'token', refreshToken: 'refresh', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
  },
  async store() { return { accountId: 'acct', credentialRef: 'ref-1' } },
}
const ctx: ConnectorContext = { workspaceId: 'ws-selector', accountId: 'acct-selector' }

describe('router API selector admission', () => {
  it('refuses a canary-ready router platform whose API selectors are not configured', () => {
    const { source, trust } = signedJdSource()
    const result = buildHttpConnectorConfigs(source, { capabilityEvidenceTrust: trust })

    // Before this gate existed the same source produced `ready: true`,
    // `reasons: []`, an admitted `configs.jd`, and a terminal NOT_CONFIGURED on
    // every signed call. Readiness is what `/readyz` and the ECS preflight read.
    expect(result.readiness.jd.ready).toBe(false)
    expect(result.readiness.jd.reasons).toContain('API_SELECTOR_MISSING')
    expect(result.configs.jd).toBeUndefined()
    // The operator is told the deployment key, not just the internal path.
    for (const key of Object.keys(jdSelectors)) expect(result.missing.jd).toContain(key)
  })

  it('still produces the terminal NOT_CONFIGURED failure it now refuses to admit', async () => {
    // The candidate config is exactly what the old gate handed to the runtime;
    // the signer is unchanged and still refuses rather than signing another
    // operation's API. That is why the configuration, not the request, is where
    // this has to be fixed.
    const { source, trust } = signedJdSource()
    const candidate = buildHttpConnectorConfigs(source, { capabilityEvidenceTrust: trust }).allConfigs.jd
    expect(candidate).toBeDefined()
    const connector = createConfiguredConnector('jd', { config: candidate!, credentials, fetch: vi.fn(), allowTestAdapters: true })
    const failure = await connector.createProduct(ctx, { idempotencyKey: 'unconfigured', fields: { title: 'x', category: 'c', price: 1, stock: 1 } })
      .then(() => undefined, error => error as { normalized?: { code?: string; retryable?: boolean; message?: string } })
    expect(failure?.normalized?.code).toBe('NOT_CONFIGURED')
    expect(failure?.normalized?.retryable).toBe(false)
    expect(failure?.normalized?.message).toContain('api.methods.create')
  })

  it('admits the same platform and signs create/update/query/sync once every selector is configured', async () => {
    const { source, trust } = signedJdSource(jdSelectors)
    const result = buildHttpConnectorConfigs(source, { capabilityEvidenceTrust: trust })
    expect(result.readiness.jd.reasons).toEqual([])
    expect(result.readiness.jd.ready).toBe(true)
    expect(result.missing.jd).toEqual([])
    const config = result.configs.jd
    expect(config).toBeDefined()
    expect(config?.api.methods).toEqual({
      sync: 'jingdong.ware.search', create: 'jingdong.ware.create', update: 'jingdong.ware.update', query: 'jingdong.ware.status.get', media: 'jingdong.ware.image.upload',
    })

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: { ware_id: 'W-1', request_id: 'req-1' } }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const connector = createConfiguredConnector('jd', { config: config!, credentials, fetch: fetchMock, allowTestAdapters: true })
    const receipt = await connector.createProduct(ctx, { idempotencyKey: 'configured', fields: { title: 'x', category: 'c', price: 1, stock: 1 } })
    expect(receipt.platform).toBe('jd')
    // The selector the signer resolved is the configured create API, and it is
    // on the wire — a mutation that stops passing `api.methods` to the signer
    // fails here as well as in readiness.
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body?: string }]
    expect(new URL(url).pathname).toBe('/api/products/create')
    expect(new URLSearchParams(init.body).get('method')).toBe('jingdong.ware.create')
  })

  it('keeps the requirement on the signer instead of on the platform name', async () => {
    // A bearer platform resolves no selector, so it is never asked for one.
    const social = buildHttpConnectorConfigsFromStructured({
      xiaohongshu: {
        clientId: 'xhs', clientSecret: 'xhs-secret',
        oauth: { authorizeUrl: 'https://xhs.test/a', tokenUrl: 'https://xhs.test/t' },
        api: { baseUrl: 'https://xhs.test/api', syncPath: '/i', createPath: '/c', updatePath: '/u', queryPath: '/q' },
      },
    })
    expect(social.allConfigs.xiaohongshu?.signer?.requiredApiSelectors).toBeUndefined()
    expect(social.readiness.xiaohongshu.reasons).not.toContain('API_SELECTOR_MISSING')

    // An explicitly injected platform signer that declares no selector contract
    // (a reviewed adapter that reads no `api.methods`) must stay admitted, so
    // the gate cannot be bypassed by, or accidentally widened for, adapters it
    // does not own.
    const verifiedAt = new Date(Date.now() - 60_000).toISOString()
    const config: HttpConnectorConfig = {
      clientId: 'tmall-app', clientSecret: 'secret-is-never-logged',
      oauth: { authorizeUrl: 'https://platform.test/oauth/authorize', tokenUrl: 'https://platform.test/oauth/token' },
      api: { baseUrl: 'https://platform.test/api', syncPath: '/products', createPath: '/products', updatePath: '/products/update', queryPath: '/publish/status' },
      signer: { kind: 'platform', sign: () => ({ 'x-platform-signature': 'platform-adapter' }) },
      mapProducts: () => [], mapWriteReceipt: (_payload, input, operation, platform) => ({ platform, operation, remoteId: input.remoteId ?? '', requestId: 'request-test', status: 'submitted', simulated: false, idempotencyKey: input.idempotencyKey }),
      mapWriteStatus: () => ({ found: true, state: 'submitted', simulated: false }),
      mediaUploadPath: '/media/upload', mapMediaUpload: () => ({ mediaId: 'media-test' }),
      mappingEvidence: { version: 'test.mapping.v1', evidenceRef: 'test-only', verifiedBy: 'unit-test', verifiedAt },
      mediaUploadEvidence: { version: 'test.media.v1', evidenceRef: 'test-only', verifiedBy: 'unit-test', verifiedAt },
      capabilityEvidence: capabilityEvidenceFor('tmall', verifiedAt),
    }
    expect(validateConnectorReadiness('tmall', config).reasons).not.toContain('API_SELECTOR_MISSING')
    expect(validateConnectorReadiness('tmall', config).ready).toBe(true)
  })

  it('names the missing structured field as api.methods.<selector>', () => {
    const structured = {
      jd: {
        clientId: 'jd', clientSecret: 'jd-secret',
        oauth: { authorizeUrl: 'https://jd.test/a', tokenUrl: 'https://jd.test/t' },
        api: { baseUrl: 'https://jd.test/api', syncPath: '/i', createPath: '/c', updatePath: '/u', queryPath: '/q', methods: { sync: 'jingdong.ware.search' } },
      },
    }
    const incomplete = buildHttpConnectorConfigsFromStructured(structured)
    expect(incomplete.readiness.jd.reasons).toContain('API_SELECTOR_MISSING')
    expect(incomplete.missing.jd).toEqual(expect.arrayContaining(['api.methods.create', 'api.methods.update', 'api.methods.query', 'api.methods.media']))
    expect(incomplete.missing.jd).not.toContain('api.methods.sync')
    expect(incomplete.configs.jd).toBeUndefined()

    const complete = buildHttpConnectorConfigsFromStructured({
      jd: { ...structured.jd, api: { ...structured.jd.api, methods: { sync: 'jingdong.ware.search', create: 'jingdong.ware.create', update: 'jingdong.ware.update', query: 'jingdong.ware.status.get', media: 'jingdong.ware.image.upload' } } },
    })
    expect(complete.readiness.jd.reasons).not.toContain('API_SELECTOR_MISSING')
  })

  it('has every router signer declare the selectors it resolves, and no other signer declare any', () => {
    // This is the anti-drift assertion: the requirement is only correct while
    // the signers that consume `api.methods` are exactly the signers that
    // declare it. Deleting a declaration turns the admission gate off for that
    // platform, and adding a router signer without one turns this red.
    for (const signer of [
      createJdSigner({ appKey: 'jd-key', appSecret: 'jd-secret' }),
      createAlibabaTopSigner({ appKey: 'tb-key', appSecret: 'tb-secret' }),
      createPinduoduoSigner({ clientId: 'pdd-client', clientSecret: 'pdd-secret' }),
    ]) {
      expect(signer.requiredApiSelectors).toEqual(PLATFORM_API_SELECTORS)
    }
  })
})
