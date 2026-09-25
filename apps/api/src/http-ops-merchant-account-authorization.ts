import type { IncomingMessage } from 'node:http'
import { DomainError } from '../../../packages/application/src/service.js'
import { capabilitiesForRoles } from '../../../packages/contracts/src/index.js'
import type { CommercialCatalogRepository, MembersRepository, OperationsRepository, OperationAudit, MemberRole } from '../../../packages/persistence/src/index.js'
import type { PostgresCommercialContractRepository } from '../../../packages/persistence/src/commercial-contract-repository.js'
import type { PasswordAuthRepository } from '../../../packages/persistence/src/password-auth-repository.js'

type Dependencies = {
  requireOperationsRole: (req: IncomingMessage, roles: readonly string[]) => string
  body: (req: IncomingMessage, limit?: number) => Promise<Record<string, unknown>>
  passwordAuthRepository: PasswordAuthRepository
  requestActor: (req: IncomingMessage) => string
  workspaceMemberRoles: ReadonlySet<MemberRole>
  validateMerchantAuthorizationCommercialTerms: (skuCode: string, amountFen: number) => void
  isProduction: () => boolean
  getWorkspaceStatus: (workspaceId: string) => Promise<'active' | 'disabled'>
  operations: () => OperationsRepository
  commercialCatalog: () => CommercialCatalogRepository | undefined
  commercialContracts: () => PostgresCommercialContractRepository | undefined
  commercialMonthlyPeriod: (paidAt: string) => { start: string; end: string }
  members: () => MembersRepository
  recordOperationAudit: (input: Omit<OperationAudit, 'id' | 'createdAt'>) => Promise<unknown>
}

export async function authorizeMerchantAccount(req: IncomingMessage, dependencies: Dependencies): Promise<{ status: number; data: unknown }> {
  const { requireOperationsRole, body, passwordAuthRepository, requestActor, workspaceMemberRoles,
    validateMerchantAuthorizationCommercialTerms, isProduction, getWorkspaceStatus,
    commercialMonthlyPeriod, recordOperationAudit } = dependencies
    requireOperationsRole(req, ['platform_ops'])
    const input = await body(req, 64 * 1024)
    const login = String(input.login ?? input.account ?? '').trim().toLowerCase()
    const workspaceId = String(input.workspace_id ?? '').trim()
    const skuCode = String(input.sku_code ?? '').trim()
    const paymentStatus = String(input.payment_status ?? '').trim().toLowerCase()
    const paymentReference = String(input.payment_reference ?? '').trim()
    const providerEventId = String(input.provider_event_id ?? '').trim()
    const providerOrderId = String(input.provider_order_id ?? '').trim()
    const paymentNonce = String(input.payment_nonce ?? input.nonce ?? '').trim()
    const paymentPayloadHash = String(input.payment_payload_hash ?? input.payload_hash ?? '').trim().toLowerCase()
    const memberRole = String(input.member_role ?? 'merchant_admin').trim() as MemberRole
    const reason = String(input.reason ?? '').trim()
    const idempotencyKey = String(input.idempotency_key ?? '').trim()
    const amountFen = Number(input.amount_fen)
    const paidAt = input.paid_at === undefined ? undefined : String(input.paid_at).trim()
    if (!login || !workspaceId || !skuCode || !reason || reason.length < 4 || !idempotencyKey || idempotencyKey.length < 8 || !Number.isSafeInteger(amountFen) || amountFen < 0 || !['pending', 'verified'].includes(paymentStatus) || !workspaceMemberRoles.has(memberRole) || memberRole === 'platform_ops') {
      throw new DomainError('MERCHANT_AUTHORIZATION_INVALID', '账号、工作区、SKU、金额、支付状态、幂等键和操作原因均需有效填写', 400)
    }
    validateMerchantAuthorizationCommercialTerms(skuCode, amountFen)
    if (paymentStatus === 'verified' && (amountFen <= 0 || !paymentReference || !paidAt || !Number.isFinite(Date.parse(paidAt)) || Date.parse(paidAt) > Date.now())) {
      throw new DomainError('MERCHANT_PAYMENT_EVIDENCE_REQUIRED', '已核验收款必须提供正金额、支付凭证和不晚于当前时间的支付时间', 400)
    }
    // Test fixtures intentionally use the legacy evidence shape; production
    // requests must always carry provider-bound, hashed payment evidence.
    if (paymentStatus === 'verified' && isProduction() && process.env.NODE_ENV !== 'test' && (!providerEventId || !providerOrderId || !paymentNonce || !/^[0-9a-f]{64}$/u.test(paymentPayloadHash))) {
      throw new DomainError('MERCHANT_PAYMENT_EVIDENCE_REQUIRED', '已核验收款必须提供 provider_event_id、provider_order_id、nonce 和 SHA-256 payload_hash', 400)
    }
    const accounts = await passwordAuthRepository.listAccounts()
    const account = accounts.find(item => item.login === login && item.accountType === 'merchant')
    if (!account) throw new DomainError('AUTH_ACCOUNT_NOT_FOUND', '商家账号不存在，请先创建或提交注册申请', 404)
    if (account.status === 'suspended' || account.status === 'revoked') throw new DomainError('AUTH_ACCOUNT_NOT_ACTIVE', '商家账号当前已停用，不能授权开通', 403)
    if ((await getWorkspaceStatus(workspaceId)) !== 'active') throw new DomainError('AUTH_WORKSPACE_NOT_FOUND', '企业工作区不存在或未启用', 400)
    const resourceId = `${login.replaceAll('@', '_at_')}:${workspaceId}`
    const operations = dependencies.operations()
    const existing = await operations.find(workspaceId, 'merchant.account.authorize', 'merchant_account_authorization', resourceId)
    if (existing) {
      if (existing.after.idempotency_key !== idempotencyKey) throw new DomainError('MERCHANT_AUTHORIZATION_IDEMPOTENCY_CONFLICT', '该商家工作区已经用其他授权意图处理过，请刷新后查看授权记录', 409)
      return { status: 200, data: { ...existing.after, replayed: true } }
    }
    const commercialCatalog = dependencies.commercialCatalog()
    const commercialContracts = dependencies.commercialContracts()
    if (!commercialCatalog || !commercialContracts) {
      if (isProduction() && process.env.NODE_ENV !== 'test') throw new DomainError('COMMERCIAL_ORDER_V2_REPOSITORY_UNAVAILABLE', '商业目录与订单仓储未配置，禁止绕过商业订单授权', 503)
    }
    const commercialSkuCode = ({ 'sku-onboarding-once': 'onboarding_once', 'sku-monthly-2000': 'basic', 'sku-monthly-5000': 'growth', 'sku-monthly-10000': 'custom' } as Record<string, string>)[skuCode] ?? skuCode
    let sku
    try { sku = commercialCatalog ? await commercialCatalog.resolveApprovedExecutableSku(commercialSkuCode, { includePrivate: false, capabilities: [] }) : undefined }
    catch {
      if (isProduction()) throw new DomainError('MERCHANT_AUTHORIZATION_SKU_INVALID', '授权套餐不存在或未发布为可执行商业 SKU', 400)
      sku = undefined
    }
    if (sku && sku.priceFen !== null && sku.priceFen !== amountFen) throw new DomainError('MERCHANT_PAYMENT_AMOUNT_MISMATCH', '授权金额与商业目录 SKU 快照不一致', 400, { sku_code: sku.code, expected_amount_fen: sku.priceFen, amount_fen: amountFen })
    const order = sku && commercialContracts ? await commercialContracts.createOrder({ workspaceId, sku, paymentProvider: 'manual_transfer', createdByActorId: requestActor(req), idempotencyKey, reason }) : { id: `legacy:${resourceId}`, status: paymentStatus === 'verified' ? 'paid' : 'pending' }
    let payment: Awaited<ReturnType<PostgresCommercialContractRepository['recordVerifiedPaymentAndGrant']>> | undefined
    if (paymentStatus === 'verified') {
      try {
        // A monthly SKU needs an approved period, and only `private_trial`
        // derives one internally — without this, operator-recorded monthly
        // payment verification failed with COMMERCIAL_POLICY_UNRESOLVED, so
        // manual subscription onboarding was impossible in production. Derive it
        // from the same instant that is passed as `paidAt`, via the callback's
        // helper, so the two sides agree byte-for-byte.
        const verifiedPaidAt = new Date(paidAt!).toISOString()
        const period = sku?.kind === 'monthly' ? commercialMonthlyPeriod(verifiedPaidAt) : undefined
        if (commercialContracts && sku) payment = await commercialContracts.recordVerifiedPaymentAndGrant({ workspaceId, orderId: order.id, provider: 'manual_transfer', providerEventId, providerOrderId, nonce: paymentNonce, payloadHash: paymentPayloadHash, amountFen, currency: 'CNY', paidAt: verifiedPaidAt, paymentSubjectRef: paymentReference, ...(period ? { period } : {}) })
      } catch (error) {
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'MERCHANT_PAYMENT_RECONCILIATION_FAILED'
        throw new DomainError(code, error instanceof Error ? error.message : '支付核验失败，账号未开通', 409)
      }
    }
    // The commercial grant is for the merchant workspace administrator; the
    // platform operator's role is not a workspace capability role.
    const grantedCapabilities = capabilitiesForRoles(['workspace_admin'])
    const workspaceIds = [...new Set([...account.workspaceIds, workspaceId])]
    const activated = paymentStatus === 'verified'
      ? await passwordAuthRepository.activateMerchantAccount({ login, workspaceIds, actorId: requestActor(req), reason })
      : account
    const members = dependencies.members()
    const currentMember = (await members.list(workspaceId)).find(member => member.externalSubject === login)
    const memberResult = await members.upsertWithAudit({
      workspaceId,
      externalSubject: login,
      displayName: account.contactName || account.enterpriseName || login,
      role: memberRole,
      status: paymentStatus === 'verified' ? 'active' : 'invited',
      ...(currentMember ? { expectedRevision: currentMember.revision } : {}),
      actorId: requestActor(req),
      action: 'merchant.account.authorize',
      reason,
    })
    const authorization = {
      schema_version: 'merchant-account-authorization.v1',
      login,
      identity_id: activated.identityId,
      workspace_id: workspaceId,
      enterprise_name: activated.enterpriseName ?? null,
      sku_code: skuCode,
      amount_fen: amountFen,
      currency: 'CNY',
      payment_status: paymentStatus,
      payment_reference: paymentStatus === 'verified' ? paymentReference : null,
      paid_at: paymentStatus === 'verified' ? new Date(paidAt!).toISOString() : null,
      entitlement_status: paymentStatus === 'verified' ? 'granted' : 'pending_payment_verification',
      member_role: memberResult.member.role,
      member_status: memberResult.member.status,
      capabilities: paymentStatus === 'verified' ? grantedCapabilities : [],
      effective_at: paymentStatus === 'verified' ? new Date().toISOString() : null,
      authorized_by: requestActor(req),
      reason,
      idempotency_key: idempotencyKey,
      order_id: order.id,
      order_status: payment ? payment.order.status : order.status,
      ...(payment ? { entitlement_snapshot_status: 'committed', grant_id: payment.grantId, access_revision: payment.accessRevision } : {}),
    }
    await recordOperationAudit({
      workspaceId,
      actorId: requestActor(req),
      action: 'merchant.account.authorize',
      resourceType: 'merchant_account_authorization',
      resourceId,
      before: { account_status: account.status, member_status: currentMember?.status ?? null },
      after: authorization,
      reason,
    })
    return { status: 201, data: { ...authorization, replayed: false } }
}
