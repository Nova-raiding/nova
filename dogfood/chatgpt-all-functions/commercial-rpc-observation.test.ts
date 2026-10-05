import { describe, expect, it } from 'vitest'
import { commercialRpcRequestSignature } from './commercial-rpc-observation.js'

function request({ method = 'POST', url = 'http://127.0.0.1:4100/api/mcp', body } = {}) {
  return {
    method: () => method,
    url: () => url,
    postDataJSON: () => body,
    postData: () => JSON.stringify(body),
  }
}

describe('commercial desktop RPC response correlation', () => {
  it('matches separately materialized request wrappers for the same MCP bytes', () => {
    const eventRequest = request({ body: { method: 'ops.commercial.catalog-v2.mutate', params: { code: 'sku-a', action: 'draft' } } })
    const responseRequest = request({ body: { method: 'ops.commercial.catalog-v2.mutate', params: { code: 'sku-a', action: 'draft' } } })
    expect(eventRequest).not.toBe(responseRequest)
    expect(commercialRpcRequestSignature(eventRequest)).toBe(commercialRpcRequestSignature(responseRequest))
  })

  it('does not match another method, route, or payload', () => {
    const original = request({ body: { method: 'ops.commercial.catalog-v2.mutate', params: { code: 'sku-a' } } })
    expect(commercialRpcRequestSignature(original)).not.toBe(commercialRpcRequestSignature(request({ body: { method: 'ops.commercial.catalog-v2.list', params: { code: 'sku-a' } } })))
    expect(commercialRpcRequestSignature(original)).not.toBe(commercialRpcRequestSignature(request({ url: 'http://127.0.0.1:4100/api/other', body: { method: 'ops.commercial.catalog-v2.mutate', params: { code: 'sku-a' } } })))
    expect(commercialRpcRequestSignature(original)).not.toBe(commercialRpcRequestSignature(request({ body: { method: 'ops.commercial.catalog-v2.mutate', params: { code: 'sku-b' } } })))
  })
})
