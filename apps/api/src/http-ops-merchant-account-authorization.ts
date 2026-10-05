import type { IncomingMessage } from 'node:http'
import { DomainError } from '../../../packages/application/src/service.js'
import type { OperationsRepository } from '../../../packages/persistence/src/operations-repository.js'

type Dependencies = {
  requireOperationsRole: (req: IncomingMessage, roles: readonly string[]) => string
  body: (req: IncomingMessage, limit?: number) => Promise<Record<string, unknown>>
  operations: () => OperationsRepository
}

/** Compatibility lookup only. Ordinary paid activation goes through frozen
 * commercial orders and real receipt allocation, never this legacy payload. */
export async function authorizeMerchantAccount(req: IncomingMessage, dependencies: Dependencies): Promise<{ status: number; data: unknown }> {
  dependencies.requireOperationsRole(req, ['platform_ops', 'platform_admin', 'ops_admin'])
  const input = await dependencies.body(req, 64 * 1024)
  const login = typeof input.login === 'string' ? input.login.trim().toLowerCase() : ''
  const workspaceId = typeof input.workspace_id === 'string' ? input.workspace_id.trim() : ''
  const idempotencyKey = typeof input.idempotency_key === 'string' ? input.idempotency_key.trim() : ''
  if (!login || !workspaceId || !idempotencyKey) throw new DomainError('MERCHANT_AUTHORIZATION_INVALID', '查询历史授权需要账号、企业工作区和原幂等标识', 400)
  const resourceId = `${login.replaceAll('@', '_at_')}:${workspaceId}`
  const existing = await dependencies.operations().find(workspaceId, 'merchant.account.authorize', 'merchant_account_authorization', resourceId)
  if (existing && existing.after.idempotency_key === idempotencyKey) {
    return { status: 200, data: { ...existing.after, replayed: true, read_only: true } }
  }
  throw new DomainError('MERCHANT_LEGACY_AUTHORIZATION_DISABLED', '旧账号授权接口已停止新建及收款核验。请通过商业订单代购及真实收款分配开通；原有效订单仍可查询与履约。', 410, {
    retryable: false, order_created: false, payment_verified: false, commercial_qualification_granted: false,
    next_actions: ['ops.commercial.order.preview', 'ops.commercial.order.create', 'ops.commercial.receipt.record'],
  })
}
