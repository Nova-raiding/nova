import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getMcpMethodPolicy } from './authz.js'
import { validateMcpRequest } from './mcp.js'
import { getHttpOperationPolicy } from './http-authz.js'
import { COMMERCIAL_OPERATION_REGISTRY } from './commercial-operation-registry.js'
import { resolveCommercialOperation } from './commercial-access.js'

const method = 'commercial.notifications.mark-read'
const request = (params: Record<string, string>) => ({ jsonrpc: '2.0', id: 'notification', method, params })

describe('member-owned commercial notification read state', () => {
  it('accepts only notification intent and a bounded original idempotency key', () => {
    const valid = { notification_id: 'notification-1', idempotency_key: 'notification-key-1' }
    expect(validateMcpRequest(request(valid)).valid).toBe(true)
    expect(validateMcpRequest(request({ notification_id: 'notification-1' })).valid).toBe(false)
    expect(validateMcpRequest(request({ ...valid, idempotency_key: 'x' })).valid).toBe(false)
    expect(validateMcpRequest(request({ ...valid, idempotency_key: 'x'.repeat(129) })).valid).toBe(false)
    expect(validateMcpRequest(request({ ...valid, notification_id: 'x'.repeat(257) })).valid).toBe(false)
    for (const field of ['member_id', 'actor_id', 'read_at', 'order_id', 'amount_fen']) {
      expect(validateMcpRequest(request({ ...valid, [field]: 'injected' })).valid).toBe(false)
    }
  })

  it('treats this as a self-scoped metadata write without financial authority', () => {
    expect(getMcpMethodPolicy(method)).toMatchObject({ capability: 'billing.self.read', scope: 'self', effect: 'write', dataClass: 'customer_metadata', obligations: ['idempotency'] })
    expect(getMcpMethodPolicy('commercial.notifications.list')?.effect).toBe('read')
    expect(resolveCommercialOperation(COMMERCIAL_OPERATION_REGISTRY, { surface: 'MCP', operation: method })).toMatchObject({ outcome: 'REGISTERED', policy: { classification: 'RECOVERY_CONTROL', rate_action: null } })
    expect(resolveCommercialOperation(COMMERCIAL_OPERATION_REGISTRY, { surface: 'MCP', operation: `${method}.extra` }).outcome).toBe('DENY_UNCLASSIFIED')
  })

  it('registers one exact authenticated HTTP route', () => {
    const route = getHttpOperationPolicy('POST', '/v1/commercial/notifications/notification-1/read')!
    expect(route).toMatchObject({ authentication: 'identity', mcpMethod: method })
    expect(resolveCommercialOperation(COMMERCIAL_OPERATION_REGISTRY, { surface: 'HTTP', operation: route.operation })).toMatchObject({ outcome: 'REGISTERED', policy: { classification: 'RECOVERY_CONTROL', rate_action: null } })
    expect(getHttpOperationPolicy('GET', '/v1/commercial/notifications/notification-1/read')).toBeUndefined()
    expect(getHttpOperationPolicy('POST', '/v1/commercial/notifications/notification-1/read/extra')).toBeUndefined()
  })

  it('actually discovers an idempotent non-financial write through source stdio', () => {
    const root = fileURLToPath(new URL('../../../apps/plugin/', import.meta.url))
    const child = spawnSync(process.execPath, [`${root}mcp/bridge.mjs`], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, NODE_ENV: 'test', MERCHANT_MCP_BASE_URL: 'http://127.0.0.1:8790', MERCHANT_WORKSPACE_ID: 'ws_notification_contract', MERCHANT_MCP_TOKEN_SOURCE: 'environment' },
      input: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n',
    })
    expect(child.status, child.stderr).toBe(0)
    const response = JSON.parse(child.stdout.trim().split('\n')[0]!)
    const tool = response.result.tools.find((entry: { name: string }) => entry.name === method)
    expect(tool).toMatchObject({ name: method, inputSchema: { additionalProperties: false, required: ['notification_id', 'idempotency_key'] }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } })
  })
})
