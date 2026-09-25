import type { IncomingMessage, ServerResponse } from 'node:http'
import type { MerchantService, SyncJob } from '../../../packages/application/src/service.js'

type Page = { limit: number; offset: number }

export interface HttpSyncJobReadDependencies {
  service: MerchantService
  resolveWorkspace: (request: IncomingMessage, candidate?: unknown) => string
  paginationRequest: (url: URL) => Page
  projectSyncWorkflow: (workspaceId: string, job: SyncJob) => unknown
  send: (response: ServerResponse, status: number, workspaceId: string, data: unknown, error: null, request: IncomingMessage) => void
}

export function handleHttpSyncJobRead(req: IncomingMessage, res: ServerResponse, path: string, url: URL, dependencies: HttpSyncJobReadDependencies): boolean {
  const { service, resolveWorkspace, paginationRequest, projectSyncWorkflow } = dependencies
  const send = (response: ServerResponse, status: number, workspaceId: string, data: unknown, error: null, request: IncomingMessage) => {
    dependencies.send(response, status, workspaceId, data, error, request)
    return true
  }
  if (req.method === 'GET' && path === '/v1/sync-jobs') {
    const workspaceId = resolveWorkspace(req, url.searchParams.get('workspace_id') ?? undefined)
    const page = paginationRequest(url)
    return send(res, 200, workspaceId, url.searchParams.has('limit') || url.searchParams.has('offset') ? service.listSyncJobsPage(workspaceId, page) : service.listSyncJobs(workspaceId), null, req)
  }
  const syncJobMatch = path.match(/^\/v1\/sync-jobs\/([^/]+)$/)
  if (req.method === 'GET' && syncJobMatch) {
    const workspaceId = resolveWorkspace(req)
    const job = service.getSyncJob(workspaceId, syncJobMatch[1]!)
    return send(res, 200, workspaceId, { ...job, workflow: projectSyncWorkflow(workspaceId, job) }, null, req)
  }
  return false
}
