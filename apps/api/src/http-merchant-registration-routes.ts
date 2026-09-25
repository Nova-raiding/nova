import type { IncomingMessage, ServerResponse } from 'node:http'
import { DomainError } from '../../../packages/application/src/service.js'
import type { PasswordAuthRepository } from '../../../packages/persistence/src/password-auth-repository.js'

type Dependencies = {
  passwordAuthRepository: PasswordAuthRepository
  requireOperationsRole: (req: IncomingMessage, roles: readonly string[]) => string
  paginationRequest: (url: URL) => { limit: number; offset: number }
  body: (req: IncomingMessage, limit?: number) => Promise<Record<string, unknown>>
  requestActor: (req: IncomingMessage) => string
  send: (res: ServerResponse, status: number, workspaceId: string, data: unknown, meta: unknown, req: IncomingMessage) => unknown
}

const operationsRoles = ['platform_ops', 'platform_admin', 'ops_admin'] as const

export async function handleHttpMerchantRegistrationRoute(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  dependencies: Dependencies,
): Promise<boolean> {
  const { passwordAuthRepository, requireOperationsRole, paginationRequest, body, requestActor, send } = dependencies

  if (req.method === 'GET' && path === '/v1/ops/merchant-registration-applications') {
    requireOperationsRole(req, operationsRoles)
    const pagination = paginationRequest(url)
    const page = await passwordAuthRepository.listMerchantRegistrationApplications(pagination)
    send(res, 200, 'unknown', {
      ...page,
      items: page.items.map(account => ({
        application_id: account.id,
        login: account.login,
        enterprise_name: account.enterpriseName ?? null,
        contact_name: account.contactName ?? null,
        status: account.status,
        workspace_ids: account.workspaceIds,
        created_at: account.createdAt,
        updated_at: account.updatedAt,
        revision: account.revision,
      })),
    }, null, req)
    return true
  }

  if (req.method === 'POST' && path === '/v1/ops/merchant-registration-applications/review') {
    requireOperationsRole(req, operationsRoles)
    const input = await body(req, 64 * 1024)
    const decision = input.decision === 'approved' || input.decision === 'rejected' ? input.decision : undefined
    const login = String(input.login ?? '').trim().toLowerCase()
    const reason = String(input.reason ?? '').trim()
    const workspaceIds = Array.isArray(input.workspace_ids)
      ? input.workspace_ids.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).map(value => value.trim())
      : []
    if (!decision || !login || reason.length < 4 || (decision === 'approved' && !workspaceIds.length)) {
      throw new DomainError('AUTH_REGISTRATION_REVIEW_INVALID', '审核决定、原因和通过时的企业工作区均需有效填写', 400)
    }
    try {
      const account = await passwordAuthRepository.reviewMerchantRegistration({ login, decision, workspaceIds, actorId: requestActor(req), reason })
      send(res, 200, 'unknown', {
        application_id: account.id,
        login: account.login,
        status: account.status,
        workspace_ids: account.workspaceIds,
        revision: account.revision,
      }, null, req)
      return true
    } catch (error) {
      const code = (error as { code?: string }).code
      throw new DomainError(
        code ?? 'AUTH_REGISTRATION_REVIEW_FAILED',
        code === 'AUTH_ACCOUNT_NOT_FOUND' ? '注册申请不存在' : code === 'AUTH_REGISTRATION_STATE_INVALID' ? '该申请已审核，不能重复操作' : '注册申请审核失败',
        code === 'AUTH_ACCOUNT_NOT_FOUND' ? 404 : 400,
      )
    }
  }

  return false
}
