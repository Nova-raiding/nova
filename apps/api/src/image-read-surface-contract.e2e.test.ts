import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableCommercialFixtureHarnessForTests, server, service } from './server.js'

async function start() {
  enableCommercialFixtureHarnessForTests()
  vi.stubEnv('ALLOW_LOCAL_PAYMENT_FIXTURE', 'true')
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

describe('image job REST and MCP read contract', () => {
  afterEach(async () => {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    vi.unstubAllEnvs()
  })

  it('keeps a queued, pending-archive job in normal wait state on both read surfaces', async () => {
    const base = await start()
    const workspaceId = `ws_image_read_contract_${Date.now()}`
    const product = service.importProduct({ workspaceId, platform: 'taobao', title: '跨入口状态契约商品' })
    const job = service.enqueueImageGeneration({ workspaceId, productId: product.id, idempotencyKey: `read-contract-${workspaceId}` })
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-test-commercial-fixture': 'server-e2e' }

    const restResponse = await fetch(`${base}/v1/image-generation-jobs/${encodeURIComponent(job.id)}`, { headers })
    const rest = await restResponse.json() as { data: Record<string, unknown>; error: unknown }
    const mcpResponse = await fetch(`${base}/mcp`, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 'read-contract', method: 'catalog.image.get', params: { job_id: job.id } }),
    })
    const mcp = await mcpResponse.json() as { data?: { result?: Record<string, unknown> } | null; error: { code: string } | null }

    expect(restResponse.status).toBe(200)
    expect(rest.error).toBeNull()
    expect(mcp.error).toBeNull()
    expect(rest.data).toMatchObject({ job_id: job.id, state: 'queued', archive_state: 'pending', reconciliation_required: false })
    expect(mcp.data?.result).toMatchObject({ job_id: job.id, reconciliation_required: false, job: { state: 'queued', archiveState: 'pending' } })
    expect(rest.data.images).toBeUndefined()
    expect(mcp.data?.result?.images).toBeUndefined()
  })

  it('does not disclose a job when either read surface is given another workspace', async () => {
    const base = await start()
    const workspaceId = `ws_image_read_owner_${Date.now()}`
    const product = service.importProduct({ workspaceId, platform: 'taobao', title: '租户隔离图片任务' })
    const job = service.enqueueImageGeneration({ workspaceId, productId: product.id, idempotencyKey: `tenant-read-${workspaceId}` })
    const headers = { 'content-type': 'application/json', 'x-workspace-id': `${workspaceId}_other`, 'x-test-commercial-fixture': 'server-e2e' }

    const restResponse = await fetch(`${base}/v1/image-generation-jobs/${encodeURIComponent(job.id)}`, { headers })
    const rest = await restResponse.json() as { data: unknown; error: { code: string } | null }
    const mcpResponse = await fetch(`${base}/mcp`, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 'tenant-read', method: 'catalog.image.get', params: { job_id: job.id } }),
    })
    const mcp = await mcpResponse.json() as { data?: unknown; error: { code: string } | null }

    expect(restResponse.status).toBe(404)
    expect(rest.data).toBeNull()
    expect(rest.error?.code).toBe('IMAGE_GENERATION_JOB_NOT_FOUND')
    expect(mcp.data).toBeNull()
    expect(mcp.error?.code).toBe('IMAGE_GENERATION_JOB_NOT_FOUND')
    expect(JSON.stringify([rest, mcp])).not.toContain(job.id)
  })
})
