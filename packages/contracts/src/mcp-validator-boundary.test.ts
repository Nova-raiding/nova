import { describe, expect, it } from 'vitest'
import { validateMcpRequest } from './mcp.js'

describe('MCP request validator uncovered boundaries', () => {
  it('accepts a valid method call and rejects an unsupported parameter', () => {
    const request = {
      jsonrpc: '2.0',
      id: 'health-check',
      method: 'workspace.health',
      params: {},
    }

    expect(validateMcpRequest(request)).toEqual({ valid: true, errors: [] })
    expect(validateMcpRequest({
      ...request,
      params: { unexpected: 'value' },
    }).errors).toContain('workspace.health 不接受参数 params.unexpected')
  })

  it('rejects a JSON-RPC notification at the request-only validation boundary', () => {
    // MCP notifications (including notifications/initialized) are handled by
    // the transport and must not be passed to this method-call validator.
    expect(validateMcpRequest({
      jsonrpc: '2.0',
      method: 'workspace.health',
      params: {},
    })).toEqual({ valid: false, errors: ['id 必须是字符串、数字或 null'] })
  })
})
