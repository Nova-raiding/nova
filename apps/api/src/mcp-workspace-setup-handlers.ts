import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { DomainError } from '../../../packages/application/src/service.js'
import { ERROR_CODES, type OpsWorkbench } from '../../../packages/contracts/src/index.js'
import { WorkspaceBootstrapError, type WorkspaceBootstrapRepository } from '../../../packages/persistence/src/workspace-bootstrap-repository.js'
import type { WorkspaceContentSetupRepository } from '../../../packages/persistence/src/workspace-content-setup-repository.js'
import type { InteractiveConfirmationTicketRepository } from '../../../packages/persistence/src/interactive-confirmation-ticket-repository.js'
import type { OperationsRepository, OperationAudit } from '../../../packages/persistence/src/operations-repository.js'

type Params = Record<string, unknown>
type Principal = { actorId: string; externalSubject?: string; identityId?: string; workspaceIdentityIssuer?: string; issuer?: string; workbench: OpsWorkbench; memberRole?: string; sessionId?: string; sessionSubject?: string }
type Store = { platform: string; accountId: string; dataMode: string; readable: boolean; label: string }

export async function handleWorkspaceBootstrap(params: Params, deps: {
  required: (params: Params, key: string) => string
  principal?: Principal
  actorHeader?: string
  strictAuth: boolean
  fixtureMode: boolean
  repository: WorkspaceBootstrapRepository
  onWorkspaceCreated: (workspaceId: string) => void
}) {
  const displayName = deps.required(params, 'display_name')
  if (displayName.length > 120) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'display_name 不能超过 120 个字符', 400)
  const principal = deps.principal
  const actorId = principal?.actorId ?? deps.actorHeader?.trim() ?? 'merchant_owner'
  if (!actorId) throw new DomainError(ERROR_CODES.UNAUTHENTICATED, '创建工作区需要可识别的商家身份', 401)
  const claimedSubject = typeof params.external_subject === 'string' && params.external_subject.trim() ? params.external_subject.trim() : undefined
  const externalSubject = principal?.externalSubject ?? actorId
  if (claimedSubject && claimedSubject !== actorId && claimedSubject !== externalSubject) throw new DomainError(ERROR_CODES.FORBIDDEN, '新工作区 owner 只能绑定当前认证身份；external_subject 不能替代认证主体', 403)
  const trustedIssuer = principal?.workspaceIdentityIssuer ?? principal?.issuer
  if (deps.strictAuth && (!principal || !trustedIssuer || !principal.externalSubject || !principal.identityId || principal.workbench !== 'workspace')) throw new DomainError(ERROR_CODES.UNAUTHENTICATED, '解析管理员分配的工作区需要可信认证凭据提供 issuer、subject 和 workspace workbench', 401)
  const issuer = trustedIssuer ?? (deps.fixtureMode ? 'urn:merchant:fixture' : 'urn:merchant:local')
  try {
    const allowCreate = !deps.strictAuth
    const bootstrapped = await deps.repository.bootstrap({ issuer, externalSubject, ...(principal?.identityId ? { identityId: principal.identityId } : {}), ...(allowCreate ? { candidateWorkspaceId: `ws_${randomUUID().replaceAll('-', '').slice(0, 24)}` } : {}), displayName, actorId, allowCreate })
    deps.onWorkspaceCreated(bootstrapped.workspaceId)
    return { workspaceId: bootstrapped.workspaceId, displayName: bootstrapped.displayName, status: 'active', reused: !bootstrapped.created, owner: { issuer, externalSubject, actorId }, binding: { environmentVariable: 'MERCHANT_WORKSPACE_ID', requiredValue: bootstrapped.workspaceId, nextStep: '将该值绑定到 Codex 插件后重新调用 workspace.health' } }
  } catch (error) {
    if (error instanceof WorkspaceBootstrapError) {
      if (error.code === 'WORKSPACE_BOOTSTRAP_BINDING_INACTIVE') throw new DomainError(error.code, '该身份已有工作区绑定，但工作区或 owner 成员已停用；请联系管理员恢复，不能另建工作区绕过停用', 409)
      if (error.code === 'WORKSPACE_ADMIN_ASSIGNMENT_REQUIRED') throw new DomainError(error.code, '当前身份尚未绑定管理员分配的工作区；请联系平台管理员完成工作区分配和本地插件绑定', 403)
      throw new DomainError(error.code, '认证身份与 workspace binding 不一致', 403)
    }
    throw error
  }
}

export async function handleWorkspaceContentSetupConfirm(workspaceId: string, params: Params, deps: {
  required: (params: Params, key: string) => string
  principal?: Principal
  stores: () => readonly Store[]
  actorId: () => string
  repository: WorkspaceContentSetupRepository
}) {
  if (deps.principal?.memberRole !== 'workspace_owner') throw new DomainError(ERROR_CODES.FORBIDDEN, '只有当前工作区 owner 可以确认首次内容工作区设置', 403)
  const displayName = deps.required(params, 'display_name').normalize('NFKC').trim()
  if (!displayName || displayName.length > 120 || /[\u0000-\u001f\u007f\u200b-\u200f]/u.test(displayName)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '工作区名称不能为空、过长或包含控制字符', 400)
  const platform = deps.required(params, 'platform')
  const accountId = deps.required(params, 'account_id')
  const store = deps.stores().find(candidate => candidate.platform === platform && candidate.accountId === accountId && candidate.dataMode === 'official_api' && candidate.readable)
  if (!store) throw new DomainError(ERROR_CODES.FORBIDDEN, '只能用当前工作区已核验的官方可读店铺建立内容工作区', 403)
  const saved = await deps.repository.confirm({ workspaceId, displayName, platform, accountId, actorId: deps.actorId() })
  return { display_name: saved.displayName, store: { platform: saved.platform, label: store.label }, confirmed_at: saved.confirmedAt, status: 'confirmed', message: '内容工作区设置已保存；完成进度仍以店铺扫描及生产门禁重新核验为准' }
}

export async function handleWorkspaceInteractiveConfirm(workspaceId: string, params: Params, deps: {
  principal?: Principal
  actorHeader?: string
  repository: InteractiveConfirmationTicketRepository
}) {
  const actorId = deps.principal?.actorId ?? deps.actorHeader?.trim() ?? 'merchant'
  const sessionId = deps.principal?.sessionId ?? deps.principal?.sessionSubject ?? `api-token:${actorId}`
  const suppliedIntentHash = typeof params.intent_hash === 'string' ? params.intent_hash.trim() : ''
  if (suppliedIntentHash && !/^[a-f0-9]{64}$/u.test(suppliedIntentHash)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'intent_hash 必须是 64 位小写 SHA-256', 400)
  const intentHash = suppliedIntentHash || createHash('sha256').update(`interactive-session:${workspaceId}:${actorId}:${sessionId}`).digest('hex')
  const rawNonce = randomBytes(32).toString('hex')
  const storedNonceHash = createHash('sha256').update(rawNonce).digest('hex')
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString()
  const ticket = await deps.repository.issue({ workspaceId, actorId, sessionId, intentHash, nonceHash: storedNonceHash, expiresAt })
  return { enabled: true, scope: 'current_interactive_session', expires_in_seconds: 900, automation: 'read_only', ticket: { nonce_hash: rawNonce, intent_hash: ticket.intentHash, expires_at: ticket.expiresAt }, message: '仅当前交互会话开放写操作；钱包、事实、审核、平台能力和发布确认门禁仍然生效' }
}

export async function handleServiceBoundaryAccept(workspaceId: string, params: Params, deps: {
  required: (params: Params, key: string) => string
  actorId: () => string
  policyVersion: string
  policyChecksum: string
  operations: Pick<OperationsRepository, 'find'>
  recordAudit: (input: Omit<OperationAudit, 'id' | 'createdAt'>) => Promise<void>
}) {
  const actorId = deps.actorId()
  const policyVersion = deps.required(params, 'policy_version')
  const policyChecksum = deps.required(params, 'policy_checksum')
  const acceptanceRef = deps.required(params, 'acceptance_ref')
  const customerSubjectRef = actorId
  const acceptedAt = deps.required(params, 'accepted_at')
  const idempotencyKey = deps.required(params, 'idempotency_key')
  if (policyVersion !== deps.policyVersion || policyChecksum !== deps.policyChecksum) throw new DomainError('SERVICE_BOUNDARY_POLICY_VERSION_INVALID', '服务边界协议版本或校验和已失效，请刷新后重新确认', 409, { current_policy_version: deps.policyVersion, current_policy_checksum: deps.policyChecksum })
  const acceptedTime = Date.parse(acceptedAt)
  if (!Number.isFinite(acceptedTime) || new Date(acceptedTime).toISOString() !== acceptedAt || acceptedTime > Date.now()) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'accepted_at 必须是规范 ISO 格式且不晚于当前时间的时间戳', 400)
  const existing = await deps.operations.find(workspaceId, 'commercial.service-boundary.accept', 'service_boundary_acceptance', acceptanceRef)
  if (existing) {
    const same = existing.actorId === actorId && existing.after.customer_subject_ref === customerSubjectRef && existing.after.policy_version === policyVersion && existing.after.policy_checksum === policyChecksum && existing.after.accepted_at === acceptedAt && existing.after.idempotency_key === idempotencyKey && existing.after.accepted === true
    if (!same) throw new DomainError('SERVICE_BOUNDARY_ACCEPTANCE_CONFLICT', 'acceptance_ref 已绑定其他客户确认事实', 409)
    return { schema_version: 'commercial.service-boundary.acceptance.v1', acceptance_ref: acceptanceRef, customer_subject_ref: customerSubjectRef, policy_version: policyVersion, policy_checksum: policyChecksum, accepted_at: acceptedAt, accepted: true, replayed: true }
  }
  await deps.recordAudit({ workspaceId, actorId, action: 'commercial.service-boundary.accept', resourceType: 'service_boundary_acceptance', resourceId: acceptanceRef, before: {}, after: { acceptance_ref: acceptanceRef, customer_subject_ref: customerSubjectRef, policy_version: policyVersion, policy_checksum: policyChecksum, accepted_at: acceptedAt, idempotency_key: idempotencyKey, accepted: true }, reason: '客户确认人工服务边界及结果声明' })
  return { schema_version: 'commercial.service-boundary.acceptance.v1', acceptance_ref: acceptanceRef, customer_subject_ref: customerSubjectRef, policy_version: policyVersion, policy_checksum: policyChecksum, accepted_at: acceptedAt, accepted: true, replayed: false }
}
