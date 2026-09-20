import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validatePlatformExchangeTranscripts } from './platform-transcript-gate.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/**
 * The read method the shipped connector dispatches per platform, as probed
 * through the real signers: the router gateways fold the credential into their
 * signed parameter set and must carry a body, the bearer platforms keep it in
 * `authorization` and dispatch GET. Whichever the fixture records, it is what
 * the protected verifier's policy has to agree with.
 */
const dispatchedReadMethod: Record<string, string> = { jd: 'POST', taobao: 'POST', tmall: 'POST', pinduoduo: 'POST', xiaohongshu: 'GET', douyin: 'GET' }

function fixture(platform = 'jd', overrideReadMethod?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'platform-transcript-gate-'))); roots.push(root)
  const observedAt = new Date(Date.now() - 1_000).toISOString()
  const workspaceId = `ws_${platform}`, accountId = `acct_${platform}`, origin = `https://api.${platform}.example`
  const exchanges = ['exchange_code', 'refresh_credential', 'sync_products', 'create_product', 'update_product', 'query_write', 'upload_media', 'revoke'].map(operation => ({
    platform, operation, workspaceId, accountId,
    method: operation === 'sync_products' ? (overrideReadMethod ?? dispatchedReadMethod[platform] ?? 'POST') : 'POST',
    origin, status: 200, observedAt, transport: 'fetch',
    ...(['create_product', 'update_product', 'query_write'].includes(operation) ? { providerRequestId: `provider-${operation}` } : {}),
  }))
  const transcript = { schema_version: 'provider-exchanges/1', release_id: 'release-1', platform, workspace_id: workspaceId, account_id: accountId, exchanges }
  const path = join(root, `capability.json.${platform}.exchanges.json`)
  const bytes = Buffer.from(`${JSON.stringify(transcript)}\n`)
  writeFileSync(path, bytes)
  const ref = `artifact://production/capability.json.${platform}.exchanges.json#${createHash('sha256').update(bytes).digest('hex')}`
  const document = { release_id: 'release-1', generated_at: new Date().toISOString(), platforms: [{ platform, tenant_context: { workspace_id: workspaceId, account_id: accountId }, exchange_transcript_ref: ref }] }
  return { root, path, bytes, document, transcript, observedAt }
}

describe('platform transcript metadata gate', () => {
  it('accepts a content-addressed, scoped secret-free response transcript', () => {
    const input = fixture()
    expect(validatePlatformExchangeTranscripts(input.document, input.root)).toEqual([])
  })
  it('rejects tampering and symlink substitution', () => {
    const input = fixture()
    writeFileSync(input.path, `${input.bytes.toString('utf8')}tampered`)
    expect(validatePlatformExchangeTranscripts(input.document, input.root)).toContain('jd.exchange_transcript_ref SHA-256 mismatch')
    const second = fixture(); const target = join(second.root, 'target.json')
    writeFileSync(target, second.bytes); rmSync(second.path); symlinkSync(target, second.path)
    expect(validatePlatformExchangeTranscripts(second.document, second.root)).toContain('jd.exchange_transcript_ref is missing or unsafe')
  })
  it('rejects secret-shaped fields even with a matching hash', () => {
    const input = fixture()
    input.transcript.exchanges[0] = { ...input.transcript.exchanges[0]!, authorization: 'Bearer secret' } as typeof input.transcript.exchanges[number]
    const bytes = Buffer.from(JSON.stringify(input.transcript))
    writeFileSync(input.path, bytes)
    input.document.platforms[0]!.exchange_transcript_ref = `artifact://production/capability.json.jd.exchanges.json#${createHash('sha256').update(bytes).digest('hex')}`
    expect(validatePlatformExchangeTranscripts(input.document, input.root)).toContain('jd.exchange_transcript_ref contains disallowed exchange fields')
  })
  it('rejects top-level secrets and missing successful operations', () => {
    const input = fixture()
    const altered = { ...input.transcript, authorization: 'Bearer secret', exchanges: input.transcript.exchanges.map(item => item.operation === 'revoke' ? { ...item, status: 422 } : item) }
    const bytes = Buffer.from(JSON.stringify(altered))
    writeFileSync(input.path, bytes)
    input.document.platforms[0]!.exchange_transcript_ref = `artifact://production/capability.json.jd.exchanges.json#${createHash('sha256').update(bytes).digest('hex')}`
    const errors = validatePlatformExchangeTranscripts(input.document, input.root)
    expect(errors).toContain('jd.exchange_transcript_ref contains disallowed top-level fields')
    expect(errors).toContain('jd.exchange_transcript_ref missing revoke response')
  })
  it('rejects a claimed production canary when the transcript has only successful responses', () => {
    const input = fixture()
    Object.assign(input.document.platforms[0]!, { capabilities: { read: { state: 'production_canary', error_evidence: { request_id: 'negative-1', code: 'REMOTE_ERROR', message: 'platform HTTP 422', observed_at: input.observedAt, retryable: false } } } })
    expect(validatePlatformExchangeTranscripts(input.document, input.root)).toContain('jd.read production canary error evidence lacks matching provider failure')
  })
  it('matches a scoped negative response to the claimed canary error evidence', () => {
    const input = fixture()
    input.transcript.exchanges.push({ platform: 'jd', operation: 'sync_products', workspaceId: 'ws_jd', accountId: 'acct_jd', method: 'POST', origin: 'https://api.jd.example', status: 422, observedAt: input.observedAt, providerRequestId: 'negative-1', errorCode: 'REMOTE_ERROR', errorMessage: 'platform HTTP 422', retryable: false, transport: 'fetch' } as typeof input.transcript.exchanges[number])
    const bytes = Buffer.from(JSON.stringify(input.transcript)); writeFileSync(input.path, bytes)
    input.document.platforms[0]!.exchange_transcript_ref = `artifact://production/capability.json.jd.exchanges.json#${createHash('sha256').update(bytes).digest('hex')}`
    Object.assign(input.document.platforms[0]!, { capabilities: { read: { state: 'production_canary', error_evidence: { request_id: 'negative-1', code: 'REMOTE_ERROR', message: 'platform HTTP 422', observed_at: input.observedAt, retryable: false } } } })
    expect(validatePlatformExchangeTranscripts(input.document, input.root)).toEqual([])
  })
  it('requires a real OAuth code-exchange response and distinct negative probes per capability', () => {
    const input = fixture()
    input.transcript.exchanges = input.transcript.exchanges.filter(item => item.operation !== 'exchange_code')
    let bytes = Buffer.from(JSON.stringify(input.transcript)); writeFileSync(input.path, bytes)
    input.document.platforms[0]!.exchange_transcript_ref = `artifact://production/capability.json.jd.exchanges.json#${createHash('sha256').update(bytes).digest('hex')}`
    expect(validatePlatformExchangeTranscripts(input.document, input.root)).toContain('jd.exchange_transcript_ref missing exchange_code response')
    const laterObservedAt = new Date(Date.parse(input.observedAt) + 1_000).toISOString()
    input.document.generated_at = new Date(Date.parse(laterObservedAt) + 1_000).toISOString()
    input.transcript.exchanges.push({ platform: 'jd', operation: 'exchange_code', workspaceId: 'ws_jd', accountId: 'acct_jd', method: 'POST', origin: 'https://api.jd.example', status: 200, observedAt: input.observedAt, transport: 'fetch' })
    input.transcript.exchanges.push({ platform: 'jd', operation: 'sync_products', workspaceId: 'ws_jd', accountId: 'acct_jd', method: 'POST', origin: 'https://api.jd.example', status: 422, observedAt: laterObservedAt, providerRequestId: 'negative-1', errorCode: 'VALIDATION_FAILED', errorMessage: 'HTTP connector jd request failed', retryable: false, transport: 'fetch' } as typeof input.transcript.exchanges[number])
    bytes = Buffer.from(JSON.stringify(input.transcript)); writeFileSync(input.path, bytes)
    input.document.platforms[0]!.exchange_transcript_ref = `artifact://production/capability.json.jd.exchanges.json#${createHash('sha256').update(bytes).digest('hex')}`
    const error_evidence = { request_id: 'negative-1', code: 'VALIDATION_FAILED', message: 'HTTP connector jd request failed', observed_at: laterObservedAt, retryable: false }
    Object.assign(input.document.platforms[0]!, { capabilities: { read: { state: 'production_canary', error_evidence }, full_sync: { state: 'production_canary', error_evidence } } })
    expect(validatePlatformExchangeTranscripts(input.document, input.root)).toContain('jd.full_sync production canary error evidence lacks matching provider failure')
  })
  it('accepts the read method the platform signer dispatches and refuses a contradiction', () => {
    // A bearer platform's read really is a GET — that is the shape
    // `HttpPlatformConnector.syncProducts` dispatches for its `authorization`
    // credential — so the gate has to accept it instead of driving operators to
    // record a request the connector never sends. The router half has to keep
    // biting: a GET read there is the leak the rule exists for, and a bodyless
    // write is not a shape the signer can produce either.
    const douyin = fixture('douyin')
    expect(validatePlatformExchangeTranscripts(douyin.document, douyin.root)).toEqual([])
    const xiaohongshu = fixture('xiaohongshu')
    expect(validatePlatformExchangeTranscripts(xiaohongshu.document, xiaohongshu.root)).toEqual([])
    const toleratedPost = fixture('douyin', 'POST')
    expect(validatePlatformExchangeTranscripts(toleratedPost.document, toleratedPost.root)).toEqual([])
    const leakedRouterRead = fixture('jd', 'GET')
    expect(validatePlatformExchangeTranscripts(leakedRouterRead.document, leakedRouterRead.root)).toContain('jd.exchange_transcript_ref exchange operation/status/method invalid')
    const bearerReadWithoutBody = fixture('douyin')
    bearerReadWithoutBody.transcript.exchanges.find(item => item.operation === 'create_product')!.method = 'GET'
    const bytes = Buffer.from(JSON.stringify(bearerReadWithoutBody.transcript)); writeFileSync(bearerReadWithoutBody.path, bytes)
    bearerReadWithoutBody.document.platforms[0]!.exchange_transcript_ref = `artifact://production/capability.json.douyin.exchanges.json#${createHash('sha256').update(bytes).digest('hex')}`
    expect(validatePlatformExchangeTranscripts(bearerReadWithoutBody.document, bearerReadWithoutBody.root)).toContain('douyin.exchange_transcript_ref exchange operation/status/method invalid')
  })

  it('rejects stale or future candidates and replayed, future or non-monotonic exchanges', () => {
    const input = fixture()
    const now = new Date()
    input.document.generated_at = new Date(now.getTime() - 24 * 60 * 60_000 - 1).toISOString()
    expect(validatePlatformExchangeTranscripts(input.document, input.root, now)).toContain('generated_at is outside the platform transcript candidate window')
    input.document.generated_at = new Date(now.getTime() + 5 * 60_000 + 1).toISOString()
    expect(validatePlatformExchangeTranscripts(input.document, input.root, now)).toContain('generated_at must not be more than five minutes in the future')

    input.document.generated_at = now.toISOString()
    input.transcript.exchanges[0]!.observedAt = new Date(now.getTime() - 24 * 60 * 60_000 - 1).toISOString()
    input.transcript.exchanges[1]!.observedAt = new Date(now.getTime() + 1).toISOString()
    input.transcript.exchanges[2]!.observedAt = new Date(now.getTime() - 2_000).toISOString()
    const bytes = Buffer.from(JSON.stringify(input.transcript)); writeFileSync(input.path, bytes)
    input.document.platforms[0]!.exchange_transcript_ref = `artifact://production/capability.json.jd.exchanges.json#${createHash('sha256').update(bytes).digest('hex')}`
    const errors = validatePlatformExchangeTranscripts(input.document, input.root, now)
    expect(errors).toContain('jd.exchange_transcript_ref exchange timestamp is outside the candidate generation window')
    expect(errors).toContain('jd.exchange_transcript_ref exchange timestamp is after candidate generation')
    expect(errors).toContain('jd.exchange_transcript_ref exchange timestamps must be monotonic')
  })
})
