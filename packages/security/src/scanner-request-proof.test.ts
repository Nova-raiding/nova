import { describe, expect, it } from 'vitest'
import { canonicalScannerRequestProof, createScannerRequestProof, scannerRequestBodySha256, verifyScannerRequestProof } from './scanner-request-proof.js'

const vector = {
  secret: 'scanner-golden-secret',
  method: 'POST',
  requestTarget: '/v1/internal/assets/asset_123/scan-result?mode=strict',
  workspaceId: 'ws_golden',
  timestamp: '1788066000',
  nonce: 'nonce_golden_vector_1234',
  body: '{"receipt":{"receipt_id":"scan_1"},"signature":"signed"}',
}

describe('scanner request proof', () => {
  it('matches the API canonical contract golden vector', () => {
    const bodySha256 = scannerRequestBodySha256(vector.body)
    const proof = createScannerRequestProof({ ...vector, timestampSeconds: Number(vector.timestamp) })
    expect(proof.canonical).toBe([vector.method, vector.requestTarget, vector.workspaceId, vector.timestamp, vector.nonce, bodySha256].join('\n'))
    expect(proof.bodySha256).toBe('5fe3a71cf9eee9fc1a38d4369ce7af2252c7c380db5635be4d7bdbde43a9d0fb')
    expect(proof.signature).toBe('bd15b2370f3f3f3aeb5b559920b38e970dc353259c0206bb51885657e5165d63')
    expect(proof.headers).toEqual({
      'x-scanner-timestamp': vector.timestamp,
      'x-scanner-nonce': vector.nonce,
      'x-scanner-body-sha256': proof.bodySha256,
      'x-scanner-workspace-signature': proof.signature,
    })
    expect(verifyScannerRequestProof({ ...vector, bodySha256: proof.bodySha256, signature: proof.signature, nowSeconds: Number(vector.timestamp) })).toBe(true)
  })

  it('binds the exact request target and body and uses the empty-body digest for GET', () => {
    const get = createScannerRequestProof({ secret: vector.secret, method: 'GET', requestTarget: '/v1/internal/assets/asset_123/scan-content', workspaceId: vector.workspaceId, timestampSeconds: Number(vector.timestamp), nonce: vector.nonce })
    expect(get.bodySha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(verifyScannerRequestProof({ secret: vector.secret, method: 'GET', requestTarget: '/v1/internal/assets/asset_123/scan-content', workspaceId: vector.workspaceId, timestamp: get.timestamp, nonce: get.nonce, bodySha256: get.bodySha256, signature: get.signature, nowSeconds: Number(vector.timestamp) })).toBe(true)
    expect(verifyScannerRequestProof({ ...vector, body: `${vector.body} `, bodySha256: scannerRequestBodySha256(vector.body), signature: createScannerRequestProof({ ...vector, timestampSeconds: Number(vector.timestamp) }).signature, nowSeconds: Number(vector.timestamp) })).toBe(false)
    const post = createScannerRequestProof({ ...vector, timestampSeconds: Number(vector.timestamp) })
    expect(verifyScannerRequestProof({ ...vector, workspaceId: '../other', bodySha256: post.bodySha256, signature: post.signature, nowSeconds: Number(vector.timestamp) })).toBe(false)
  })
})
