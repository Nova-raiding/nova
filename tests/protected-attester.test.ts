import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { signCandidate, validateCandidate } from '../infra/protected/attest-capability-evidence.mjs'
import { validateCapabilityProductionSignature } from './capability-evidence-gate.js'

const platforms = ['jd','taobao','tmall','pinduoduo','xiaohongshu','douyin']
const names = ['authorize','read','full_sync','incremental_sync','create','update','query_status','revoke','media_upload']
const operation: Record<string,string> = { authorize:'exchange_code', read:'sync_products', full_sync:'sync_products', incremental_sync:'sync_products', create:'create_product', update:'update_product', query_status:'query_write', revoke:'revoke', media_upload:'upload_media' }
const required = ['sync_products','create_product','update_product','query_write','upload_media','revoke']
const observedAt = new Date(Date.now() - 1_000).toISOString()
const binding = { releaseId:'release-1', imageSetDigest:`sha256:${'a'.repeat(64)}`, manifestSha256:'b'.repeat(64), releaseGitSha:'c'.repeat(40), deploymentNonce:'d'.repeat(24), keyId:'trusted-key-1' }

function candidate() {
  const root = realpathSync(mkdtempSync(join(tmpdir(),'protected-attester-')))
  const entries = platforms.map(platform => {
    const workspaceId = `ws_${platform}`, accountId = `acct_${platform}`
    const exchange = (name:string, status:number, id:string) => ({ platform, operation:name, workspaceId, accountId, method:name === 'sync_products' ? 'GET' : 'POST', origin:'https://provider.example', status, observedAt, providerRequestId:id, transport:'fetch', ...(status >= 400 ? { errorCode:'REJECTED', errorMessage:'controlled test rejection', retryable:false } : {}) })
    const exchanges = [exchange('exchange_code',200,'auth-good'), ...required.map(name => exchange(name,200,`good-${name}`)), ...names.map(name => exchange(operation[name]!,400,`bad-${name}`))]
    const bytes = Buffer.from(JSON.stringify({ schema_version:'provider-exchanges/1', release_id:binding.releaseId, platform, workspace_id:workspaceId, account_id:accountId, exchanges }))
    const filename = `matrix.${platform}.exchanges.json`
    writeFileSync(join(root, filename), bytes)
    const capabilities = Object.fromEntries(names.map(name => [name, { state:'production_canary', evidence_ref:`artifact://production/${platform}/${name}`, verified_by:'operator', verified_at:observedAt, api_version:'v1', scope:'catalog', protocol:{ name:'ProviderAPI', version:'v1' }, error_evidence:{ request_id:`bad-${name}`, code:'REJECTED', message:'controlled test rejection', observed_at:observedAt, retryable:false } }]))
    return { platform, application_id:`app_${platform}`, test_store_id:`store_${platform}`, tenant_context:{ workspace_id:workspaceId, account_id:accountId }, exchange_transcript_ref:`artifact://production/${filename}#${createHash('sha256').update(bytes).digest('hex')}`, capabilities }
  })
  return { root, document:{ schema_version:'1', release_id:binding.releaseId, environment:'preproduction', generated_at:observedAt, platforms:entries } }
}

describe('protected capability attester', () => {
  it('binds a complete candidate and signs the exact verifier canonical payload', () => {
    const { root, document } = candidate()
    const pair = generateKeyPairSync('ed25519')
    const signed = signCandidate(document, binding, root, pair.privateKey.export({ format:'pem', type:'pkcs8' }), pair.publicKey.export({ format:'pem', type:'spki' }))
    expect(signed.environment).toBe('production')
    expect(signed.deployment_nonce).toBe(binding.deploymentNonce)
    expect(signed.signature_base64).toMatch(/^[A-Za-z0-9+/]{86}==$/)
    expect(validateCapabilityProductionSignature(signed, { ...binding, publicKeyPem: pair.publicKey.export({ format:'pem', type:'spki' }).toString(), trustedKeyId:binding.keyId })).toEqual([])
  })
  it('rejects tampered transcript, missing negative path and mismatched key', () => {
    const { root, document } = candidate()
    const pair = generateKeyPairSync('ed25519'), wrong = generateKeyPairSync('ed25519')
    expect(() => signCandidate(document, binding, root, pair.privateKey.export({ format:'pem', type:'pkcs8' }), wrong.publicKey.export({ format:'pem', type:'spki' }))).toThrow(/does not match/)
    document.platforms[0]!.capabilities['authorize']!.error_evidence.request_id = 'fabricated'
    expect(() => validateCandidate(document, binding, root)).toThrow(/no matching provider failure/)
    document.platforms[0]!.capabilities['authorize']!.error_evidence.request_id = 'bad-authorize'
    writeFileSync(join(root,'matrix.jd.exchanges.json'), 'tampered')
    expect(() => validateCandidate(document, binding, root)).toThrow(/hash mismatch/)
  })
  it('rejects stale and future candidates plus replayed, future and non-monotonic exchanges', () => {
    const now = new Date()
    const stale = candidate()
    stale.document.generated_at = new Date(now.getTime() - 24 * 60 * 60_000 - 1).toISOString()
    expect(() => validateCandidate(stale.document, binding, stale.root, now)).toThrow(/outside the signing window/)
    const future = candidate()
    future.document.generated_at = new Date(now.getTime() + 5 * 60_000 + 1).toISOString()
    expect(() => validateCandidate(future.document, binding, future.root, now)).toThrow(/too far in the future/)

    for (const [offset, message] of [[-24 * 60 * 60_000 - 1, /outside candidate generation window/], [1, /after candidate generation/]] as const) {
      const input = candidate()
      input.document.generated_at = now.toISOString()
      const entry = input.document.platforms[0]!
      const path = join(input.root, 'matrix.jd.exchanges.json')
      const transcript = JSON.parse(readFileSync(path, 'utf8'))
      transcript.exchanges[0].observedAt = new Date(now.getTime() + offset).toISOString()
      const bytes = Buffer.from(JSON.stringify(transcript)); writeFileSync(path, bytes)
      entry.exchange_transcript_ref = `artifact://production/matrix.jd.exchanges.json#${createHash('sha256').update(bytes).digest('hex')}`
      expect(() => validateCandidate(input.document, binding, input.root, now)).toThrow(message)
    }
    const nonMonotonic = candidate()
    nonMonotonic.document.generated_at = now.toISOString()
    const entry = nonMonotonic.document.platforms[0]!
    const path = join(nonMonotonic.root, 'matrix.jd.exchanges.json')
    const transcript = JSON.parse(readFileSync(path, 'utf8'))
    transcript.exchanges[0].observedAt = new Date(now.getTime() - 1_000).toISOString()
    transcript.exchanges[1].observedAt = new Date(now.getTime() - 2_000).toISOString()
    const bytes = Buffer.from(JSON.stringify(transcript)); writeFileSync(path, bytes)
    entry.exchange_transcript_ref = `artifact://production/matrix.jd.exchanges.json#${createHash('sha256').update(bytes).digest('hex')}`
    expect(() => validateCandidate(nonMonotonic.document, binding, nonMonotonic.root, now)).toThrow(/must be monotonic/)
  })
})
