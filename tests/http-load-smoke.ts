import type { Server } from 'node:http'
import type { Product } from '../packages/application/src/service.js'

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null }

export interface HttpSmokeSummary {
  profile: 'pilot_50_http_fake'
  transport: 'real_http'
  connectorMode: 'fake'
  cloudGate: false
  workspaces: number
  requests: number
  duplicatePublishRequests: number
  acceptedPublishJobs: number
  uniquePublishJobs: number
  duplicateWrites: number
  errors: Array<{ workspaceId: string; step: string; status?: number; code?: string; message: string }>
}

const json = async <T>(response: Response): Promise<{ status: number; body: Envelope<T> }> => ({
  status: response.status,
  body: await response.json() as Envelope<T>,
})

const closeServer = (server: Server) => new Promise<void>((resolve, reject) => {
  server.close(error => error ? reject(error) : resolve())
})

/**
 * Runs the pilot profile through a real loopback HTTP server and the API route.
 * The connector remains fake by design; this is an application/HTTP smoke, not
 * evidence of platform or cloud capacity.
 */
export async function runHttpConcurrencySmoke(workspaces = 50): Promise<HttpSmokeSummary> {
  const previousFixtureMode = process.env.CONNECTOR_FIXTURE_MODE
  const previousPluginWriteEnabled = process.env.PLUGIN_WRITE_ENABLED
  process.env.NODE_ENV = 'test'
  process.env.CONNECTOR_FIXTURE_MODE = 'true'
  process.env.PLUGIN_WRITE_ENABLED = 'true'
  const api = await import('../apps/api/src/server.js')
  // Use the exported application server so its production error boundary is
  // exercised as well as the route. It is not a direct service invocation.
  const server = api.server
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('temporary HTTP server did not bind')
  const base = `http://127.0.0.1:${address.port}`
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const errors: HttpSmokeSummary['errors'] = []
  let requests = 0
  let duplicatePublishRequests = 0
  let acceptedPublishJobs = 0
  const acceptedJobIds = new Set<string>()

  const request = async <T>(workspaceId: string, step: string, path: string, init?: RequestInit) => {
    requests += 1
    const headers = new Headers(init?.headers)
    headers.set('x-workspace-id', workspaceId)
    const result = await json<T>(await fetch(`${base}${path}`, { ...init, headers }))
    if (result.status >= 400 || result.body.error) {
      errors.push({ workspaceId, step, status: result.status, code: result.body.error?.code, message: result.body.error?.message ?? `HTTP ${result.status}` })
    }
    return result
  }
  const post = (workspaceId: string, step: string, path: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
    request(workspaceId, step, path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) })

  try {
    const flows = await Promise.all(Array.from({ length: workspaces }, async (_, index) => {
      const workspaceId = `ws_http_smoke_${runId}_${index}`
      const productId = `prod_http_smoke_${runId}_${index}`
      const account = api.service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `http-smoke-${runId}-${index}`, credentialRef: 'fixture://http-smoke' })
      const product: Product = {
        id: productId,
        workspaceId,
        platform: 'taobao',
        accountId: account.id,
        storeName: `HTTP smoke ${index}`,
        remoteId: `TB-HTTP-${runId}-${index}`,
        title: `HTTP 并发测试商品 ${index}`,
        skuCount: 2,
        stock: 100,
        factsConfirmed: true,
        source: 'fixture',
        updatedAt: new Date().toISOString(),
      }
      api.service.products.set(product.id, product)

      const taskResponse = await post(workspaceId, 'create_task', '/v1/tasks', { workspace_id: workspaceId, product_id: productId, platform: 'taobao', account_id: account.id })
      const taskId = (taskResponse.body.data as { id: string } | null)?.id
      if (!taskId) return { workspaceId, duplicateWrites: 0 }
      await post(workspaceId, 'select_direction', `/v1/tasks/${taskId}/directions`, { direction_id: 'A' })
      await post(workspaceId, 'confirm_plan', `/v1/tasks/${taskId}/plan/confirm`, { expected_version: 2, actor_id: 'http-smoke' })
      const draftResponse = await post(workspaceId, 'create_draft', `/v1/tasks/${taskId}/content`, {})
      const contentVersionId = (draftResponse.body.data as { id: string } | null)?.id
      if (!contentVersionId) return { workspaceId, duplicateWrites: 0 }
      await post(workspaceId, 'approve_content', `/v1/tasks/${taskId}/approve`, { content_version_id: contentVersionId })
      const previewResponse = await post(workspaceId, 'prepare_publish', `/v1/tasks/${taskId}/publish-preview`, {})
      const preview = previewResponse.body.data as { confirmationHash: string; remoteSnapshotHash: string } | null
      if (!preview) return { workspaceId, duplicateWrites: 0 }
      const payload = { workspace_id: workspaceId, task_id: taskId, content_version_id: contentVersionId, confirmation_hash: preview.confirmationHash, remote_snapshot_hash: preview.remoteSnapshotHash, account_id: account.id }
      duplicatePublishRequests += 2
      const [first, second] = await Promise.all([
        post(workspaceId, 'publish_first', '/v1/publish-jobs', payload, { 'idempotency-key': `http-smoke-${runId}-${index}` }),
        post(workspaceId, 'publish_duplicate', '/v1/publish-jobs', payload, { 'idempotency-key': `http-smoke-${runId}-${index}` }),
      ])
      const ids = [first.body.data, second.body.data].map(value => (value as { id: string } | null)?.id).filter((value): value is string => Boolean(value))
      acceptedPublishJobs += ids.length
      ids.forEach(id => acceptedJobIds.add(id))
      return { workspaceId, duplicateWrites: ids.length - new Set(ids).size }
    }))
    return {
      profile: 'pilot_50_http_fake',
      transport: 'real_http',
      connectorMode: 'fake',
      cloudGate: false,
      workspaces,
      requests,
      duplicatePublishRequests,
      acceptedPublishJobs,
      uniquePublishJobs: acceptedJobIds.size,
      duplicateWrites: flows.reduce((sum, flow) => sum + flow.duplicateWrites, 0),
      errors,
    }
  } finally {
    await closeServer(server)
    if (previousFixtureMode === undefined) delete process.env.CONNECTOR_FIXTURE_MODE
    else process.env.CONNECTOR_FIXTURE_MODE = previousFixtureMode
    if (previousPluginWriteEnabled === undefined) delete process.env.PLUGIN_WRITE_ENABLED
    else process.env.PLUGIN_WRITE_ENABLED = previousPluginWriteEnabled
  }
}

if (process.argv[1]?.endsWith('/http-load-smoke.ts')) {
  const summary = await runHttpConcurrencySmoke(50)
  console.log(JSON.stringify(summary))
  if (summary.errors.length || summary.acceptedPublishJobs !== summary.workspaces * 2 || summary.uniquePublishJobs !== summary.workspaces || summary.duplicateWrites !== summary.workspaces) process.exitCode = 1
}
