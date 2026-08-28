import { describe, expect, it } from 'vitest'
import { createFakeConnector, profiles, type Platform, type PlatformConnector } from './index.js'

const platforms = Object.keys(profiles) as Platform[]
const context = { workspaceId: 'ws_test', accountId: 'acct_test', traceId: 'trace_test' }

describe.each(platforms)('%s connector contract', (platform) => {
  const connector = () => createFakeConnector(platform, { configured: true, allowFakeWrites: true })
  it('keeps profile isolation and maps fixture to canonical data', async () => {
    const current = connector()
    const page = await current.syncProducts(context)
    expect(page.items).toHaveLength(1)
    expect(page.simulated).toBe(true)
    expect(page.items[0]?.platformFields).toBeDefined()
    const mapped = current.mapToCanonical(page.items[0]!, { id: `${platform}.mapping.v1` })
    expect(mapped.platform).toBe(platform)
    expect(mapped.rawPlatformFields).toBeDefined()
    expect(mapped.platformUpdatedAt).toBe(page.items[0]?.observedAt)
    expect(current.profile.schemaProfile.startsWith(platform === 'pinduoduo' ? 'pdd' : platform)).toBe(true)
  })
  it('validates the profile whitelist before a write', async () => {
    const current = connector()
    expect(current.validateWrite({ fields: { title: 'ok', category: 'cat', price: 1, stock: 1, secret_token: 'nope' }, idempotencyKey: 'key' }).some(f => f.code === 'NOT_ALLOWED')).toBe(true)
    await expect(current.updateProduct(context, { fields: { title: 'ok', category: 'cat', price: 1, stock: 1, secret_token: 'nope' }, idempotencyKey: 'key' })).rejects.toMatchObject({ normalized: { code: 'VALIDATION_FAILED' } })
  })
  it('deduplicates fake writes and supports query', async () => {
    const current = connector()
    const input = { fields: { title: 'ok', category: 'cat', price: 1, stock: 1 }, idempotencyKey: `idemp-${platform}` }
    const first = await current.updateProduct(context, input)
    const second = await current.updateProduct(context, input)
    expect(second.requestId).toBe(first.requestId)
    expect(await current.queryWrite(context, { idempotencyKey: input.idempotencyKey })).toMatchObject({ found: true, requestId: first.requestId })
  })
  it('blocks sync, writes and status queries after revoke', async () => {
    const current = connector()
    await current.syncProducts(context)
    await current.revoke({ accountId: context.accountId, credentialRef: `fixture://${platform}` })
    await expect(current.syncProducts(context)).rejects.toMatchObject({ normalized: { code: 'UNAUTHORIZED', platform } })
    await expect(current.createProduct(context, { fields: { title: 'ok', category: 'cat', price: 1, stock: 1 }, idempotencyKey: `revoked-${platform}` })).rejects.toMatchObject({ normalized: { code: 'UNAUTHORIZED', platform } })
    await expect(current.queryWrite(context, { idempotencyKey: `revoked-query-${platform}` })).rejects.toMatchObject({ normalized: { code: 'UNAUTHORIZED', platform } })
  })
  it('does not pretend an unconfigured official API is connected', async () => {
    const current = createFakeConnector(platform, { configured: false, allowFakeWrites: false })
    await expect(current.authorize({ workspaceId: 'ws', actorId: 'actor', redirectUri: 'https://example.test/callback', state: 'state' })).resolves.toMatchObject({ ok: false, code: 'NOT_CONFIGURED', mode: 'not_configured' })
    await expect(current.updateProduct(context, { fields: { title: 'ok', category: 'cat', price: 1, stock: 1 }, idempotencyKey: 'not-configured' })).rejects.toMatchObject({ normalized: { code: 'NOT_CONFIGURED' } })
  })
})

describe('connector error normalization', () => {
  it('turns timeout into unknown and retryable', () => {
    const connector: PlatformConnector = createFakeConnector('jd')
    expect(connector.normalizeError({ code: 'TIMEOUT', message: 'gateway timeout' })).toMatchObject({ code: 'TIMEOUT', unknown: true, retryable: true, platform: 'jd' })
  })
})
