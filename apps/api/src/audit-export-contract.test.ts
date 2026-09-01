import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { operationAudits, server } from './server.js'

type RpcEnvelope<T = unknown> = {
  data: { result: T } | null
  error: { code: string; message: string } | null
}

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function call<T>(base: string, input: {
  method: string
  workspaceId: string
  role: string
  actorId?: string
  params?: Record<string, unknown>
}) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-workspace-id': input.workspaceId,
      'x-role': input.role,
      'x-actor-id': input.actorId ?? `${input.role}-audit-export-test`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `audit-export-${input.method}`,
      method: input.method,
      params: { workspace_id: input.workspaceId, ...(input.params ?? {}) },
    }),
  })
  return { response, body: await response.json() as RpcEnvelope<T> }
}

describe('audit export API contract', () => {
  beforeEach(() => vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000'))

  afterEach(async () => {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    vi.unstubAllEnvs()
  })

  it('requires the audit.export capability and returns a stable forbidden code', async () => {
    const base = await start()
    const result = await call(base, {
      method: 'ops.audit.export',
      workspaceId: `ws_audit_export_forbidden_${Date.now()}`,
      role: 'support',
    })

    expect(result.response.status).toBe(403)
    expect(result.body.data).toBeNull()
    expect(result.body.error).toMatchObject({ code: 'AUDIT_CENTER_FORBIDDEN' })
  })

  it('rejects a cross-workspace export before revealing the requested workspace', async () => {
    const base = await start()
    const headerWorkspace = `ws_audit_export_header_${Date.now()}`
    const bodyWorkspace = `${headerWorkspace}_foreign`
    const result = await call(base, {
      method: 'ops.audit.export',
      workspaceId: headerWorkspace,
      role: 'finance',
      params: { workspace_id: bodyWorkspace },
    })

    expect(result.response.status).toBe(403)
    expect(result.body.error?.code).toBe('WORKSPACE_SCOPE_MISMATCH')
    expect(JSON.stringify(result.body)).not.toContain(bodyWorkspace)
  })

  it('rejects a platform wildcard scope instead of exporting across tenants', async () => {
    const base = await start()
    const workspaceId = `ws_audit_export_platform_${Date.now()}`
    const result = await call(base, {
      method: 'ops.audit.export',
      workspaceId,
      role: 'platform_ops',
      params: { workspace_id: '*' },
    })

    expect(result.response.status).toBe(403)
    expect(result.body.error?.code).toBe('WORKSPACE_SCOPE_MISMATCH')
    expect(JSON.stringify(result.body)).not.toContain('workspace_id":"*')
  })

  it('exports only redacted audit fields for an authorized workspace', async () => {
    const workspaceId = `ws_audit_export_redaction_${Date.now()}`
    await operationAudits.append({
      workspaceId,
      actorId: 'audit-export-actor',
      action: 'credential.rotation.review',
      resourceType: 'integration',
      resourceId: 'resource-audit-id',
      before: { status: 'pending', access_token: 'token-must-not-leak' },
      after: { status: 'approved', payment_url: 'https://payments.invalid/private' },
      reason: '审计导出脱敏契约测试',
    })
    const base = await start()
    const result = await call<{ csv: string; rowCount: number }>(base, {
      method: 'ops.audit.export',
      workspaceId,
      role: 'finance',
    })

    expect(result.response.status).toBe(200)
    expect(result.body.error).toBeNull()
    expect(result.body.data?.result).toMatchObject({ rowCount: 1 })
    const csv = result.body.data?.result.csv ?? ''
    expect(csv).toContain('credential.rotation.review')
    expect(csv).not.toMatch(/token-must-not-leak|payments\.invalid/u)
  })
})
