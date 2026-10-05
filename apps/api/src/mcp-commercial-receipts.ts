import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { DomainError } from '../../../packages/application/src/service.js'
import { CommercialReceiptError, type PostgresCommercialReceiptRepository, type CommercialReceiptFulfill } from '../../../packages/persistence/src/commercial-receipt-repository.js'
import type { PostgresCommercialContractRepository } from '../../../packages/persistence/src/commercial-contract-repository.js'

type Params = Record<string, unknown>
export const MCP_COMMERCIAL_RECEIPT_METHODS = new Set([
  'ops.commercial.receipt.request.get', 'ops.commercial.receipt.allocation.request.get', 'ops.commercial.receipt.return.request.get',
  'ops.commercial.receipt.unmatched.return.propose', 'ops.commercial.receipt.unmatched.return.decide', 'ops.commercial.receipt.unmatched.return.complete', 'ops.commercial.receipt.unmatched.return.list',
  'ops.commercial.receipt.unmatched.record', 'ops.commercial.receipt.unmatched.list', 'ops.commercial.receipt.unmatched.match',
  'ops.commercial.receipt.allocations.preview', 'ops.commercial.receipt.allocations.confirm',
  'ops.commercial.receipt.record', 'ops.commercial.receipt.list', 'ops.commercial.receipt.get',
  'ops.commercial.receipt.allocation.preview', 'ops.commercial.receipt.allocation.confirm',
  'ops.commercial.receipt.return.propose', 'ops.commercial.receipt.return.decide',
  'ops.commercial.receipt.return.complete', 'ops.commercial.receipt.return.list',
])
export interface CommercialReceiptHandlerDependencies {
  receipts?: PostgresCommercialReceiptRepository
  contracts?: PostgresCommercialContractRepository
  actorId: string
  previewSigningKey?: string
  validateMatchTarget?(workspaceId: string, customerRef: string): Promise<void>
  required(params: Params, key: string): string
  object(params: Params, key: string): Record<string, unknown>
  fulfill: CommercialReceiptFulfill
}
function integer(params: Params, key: string, minimum = 1): number {
  const value = params[key]
  const parsed = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : typeof value === 'number' ? value : NaN
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new DomainError('INVALID_REQUEST', `${key} 必须是有效整数`, 400, { field_errors: { [key]: '无效整数' } })
  return parsed
}
function pageLimit(params: Params): number { const limit = params.limit === undefined ? 50 : integer(params, 'limit'); if (limit > 100) throw new DomainError('INVALID_REQUEST', 'limit 不得超过100', 400); return limit }
export function commercialPreviewHash(value: unknown): string {
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, next]) => [key, normalize(next)])) : item
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex')
}
const PREVIEW_TTL_MS = 5 * 60_000
function previewKey(key?: string): string {
  if (!key?.trim()) throw new DomainError('COMMERCIAL_PREVIEW_UNAVAILABLE', '服务器预览签名配置缺失', 503)
  return key
}
export function issueCommercialPreview(value: unknown, purpose: string, key?: string, now = Date.now()) {
  const deadline = now + PREVIEW_TTL_MS, digest = commercialPreviewHash(value)
  const payload = `commercial-preview-v1:${purpose}:${deadline}:${digest}`
  return { preview_hash: `p1.${deadline}.${digest}.${createHmac('sha256', previewKey(key)).update(payload).digest('hex')}`, expires_at: new Date(deadline).toISOString() }
}
export function confirmCommercialPreview(token: string, value: unknown, purpose: string, key?: string, now = Date.now()): void {
  const signingKey = previewKey(key), parts = token.split('.')
  if (parts.length !== 4 || parts[0] !== 'p1' || !/^\d{13}$/u.test(parts[1]!) || !/^[a-f0-9]{64}$/u.test(parts[2]!) || !/^[a-f0-9]{64}$/u.test(parts[3]!)) throw new DomainError('COMMERCIAL_PREVIEW_CONFLICT', '预览凭证无效，请重新确认', 409)
  const deadline = Number(parts[1]), digest = commercialPreviewHash(value)
  const signature = createHmac('sha256',signingKey).update(`commercial-preview-v1:${purpose}:${deadline}:${parts[2]}`).digest()
  if (!timingSafeEqual(signature,Buffer.from(parts[3]!,'hex')) || parts[2] !== digest) throw new DomainError('COMMERCIAL_PREVIEW_CONFLICT', '服务器明细已变化或凭证被篡改，请重新确认', 409)
  if (deadline <= now || deadline > now + PREVIEW_TTL_MS) throw new DomainError('COMMERCIAL_PREVIEW_EXPIRED', '预览已过期，请重新确认', 409)
}
function decodeCursor(params: Params, kind: string, workspaceId: string): { at: string; id: string } | undefined {
  if (params.cursor === undefined || params.cursor === null || params.cursor === '') return undefined
  try {
    if (typeof params.cursor !== 'string' || params.cursor.length > 2000 || !/^[A-Za-z0-9_-]+$/u.test(params.cursor)) throw new Error('cursor')
    const value = JSON.parse(Buffer.from(params.cursor,'base64url').toString('utf8')) as Record<string,unknown>
    if (value.kind !== kind || value.workspaceId !== workspaceId || typeof value.id !== 'string' || !value.id || value.id.length > 256 || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) throw new Error('cursor')
    return {at:new Date(value.at).toISOString(),id:value.id}
  } catch { throw new DomainError('INVALID_REQUEST','分页游标无效或不属于当前范围',400) }
}
async function receiptPage<T extends {id:string}>(params: Params,kind: string,workspaceId: string,load:(limit:number,cursor?:{at:string;id:string})=>Promise<T[]>,at:(row:T)=>string) {
  const limit=pageLimit(params), cursor=decodeCursor(params,kind,workspaceId)
  const rows=await load(Math.min(limit+1,100),cursor),items=rows.slice(0,limit),last=items.at(-1)
  const position=last ? {at:at(last),id:last.id} : undefined
  const hasMore=rows.length>limit || (limit===100 && rows.length===100 && (await load(1,position)).length>0)
  const next_cursor=hasMore && position ? Buffer.from(JSON.stringify({kind,workspaceId,...position})).toString('base64url') : null
  return {items,next_cursor}
}
/** Invoked only after central platform authorization; every target remains tenant scoped. */
export async function handleCommercialReceiptMethod(method: string, params: Params, deps: CommercialReceiptHandlerDependencies): Promise<unknown> {
  const { receipts, contracts, actorId, required, object } = deps
  if (!receipts || !contracts) throw new DomainError('COMMERCIAL_RECEIPT_REPOSITORY_UNAVAILABLE', '真实收款与交易仓储未配置', 503)
  const optionalScopeLookup = method === 'ops.commercial.receipt.request.get' || method === 'ops.commercial.receipt.return.request.get'
  const unmatched = method.startsWith('ops.commercial.receipt.unmatched.') && method !== 'ops.commercial.receipt.unmatched.match'
  if (unmatched && params.target_workspace_id !== undefined) throw new DomainError('INVALID_REQUEST', '未匹配款不能指定虚构企业', 400)
  const workspaceId = unmatched || (optionalScopeLookup && params.target_workspace_id === undefined) ? '' : required(params, 'target_workspace_id')
  const now = new Date().toISOString()
  try {
    switch (method) {
      case 'ops.commercial.receipt.request.get': {
        if (params.source !== 'bank_transfer') throw new DomainError('INVALID_REQUEST', '不支持的收款来源', 400)
        const receipt = await receipts.findReceiptByExternalIdentity(workspaceId || null, actorId, { source: 'bank_transfer', receivingAccountRef: required(params, 'receiving_account_ref'), externalTradeId: required(params, 'external_trade_id') })
        return receipt ? { schema_version: 'commercial.receipt.v1', receipt } : null
      }
      case 'ops.commercial.receipt.allocation.request.get': {
        const allocation = await receipts.getAllocationByIdempotencyKey(workspaceId, required(params, 'idempotency_key'))
        return allocation?.actorId === actorId ? { schema_version: 'commercial.receipt.allocation.v1', allocation: allocation.result, replayed: true } : null
      }
      case 'ops.commercial.receipt.return.request.get': {
        const item = await receipts.getReturnByRequestId(workspaceId || null, actorId, required(params, 'return_id'))
        return item ? { schema_version: 'commercial.receipt.return.v1', item } : null
      }
      case 'ops.commercial.receipt.unmatched.return.propose':
        return { schema_version: 'commercial.receipt.return.v1', item: await receipts.proposeUnmatchedReturn({ receiptId: required(params, 'receipt_id'), returnId: required(params, 'return_id'), amountFen: integer(params, 'amount_fen'), payerRef: required(params, 'payer_ref'), expectedRevision: integer(params, 'expected_revision'), actorId, reason: required(params, 'reason'), evidence: object(params, 'evidence_json'), at: now }) }
      case 'ops.commercial.receipt.unmatched.return.decide': {
        const action = params.decision
        if (action !== 'approve' && action !== 'reject') throw new DomainError('INVALID_REQUEST', 'decision 必须为 approve 或 reject', 400)
        return { schema_version: 'commercial.receipt.return.v1', item: await receipts.decideUnmatchedReturn({ returnId: required(params, 'return_id'), actorId, action, evidence: object(params, 'evidence_json'), at: now }) }
      }
      case 'ops.commercial.receipt.unmatched.return.complete': {
        const outcome = params.outcome
        if (outcome !== 'completed' && outcome !== 'unknown') throw new DomainError('INVALID_REQUEST', 'outcome 无效', 400)
        return { schema_version: 'commercial.receipt.return.v1', item: await receipts.completeUnmatchedReturn({ returnId: required(params, 'return_id'), actorId, outcome, ...(typeof params.external_return_id === 'string' ? { externalReturnId: params.external_return_id } : {}), evidence: object(params, 'evidence_json'), at: now }) }
      }
      case 'ops.commercial.receipt.unmatched.return.list':
        return { schema_version: 'commercial.receipt.returns.v1', ...await receiptPage(params, 'unmatched-returns', '', (limit, cursor) => receipts.listUnmatchedReturns(limit, cursor ? { createdAt: cursor.at, id: cursor.id } : undefined), row => row.createdAt) }
      case 'ops.commercial.receipt.unmatched.record': {
        if (params.source !== 'bank_transfer' || params.currency !== 'CNY') throw new DomainError('INVALID_REQUEST', '本期仅支持人民币银行转账核验', 400)
        const receipt = await receipts.recordUnmatched({ source: 'bank_transfer', receivingAccountRef: required(params,'receiving_account_ref'),externalTradeId:required(params,'external_trade_id'),payerRef:required(params,'payer_ref'),amountFen:integer(params,'amount_fen'),currency:'CNY',receivedAt:required(params,'received_at'),evidence:object(params,'evidence_json'),actorId,verifiedAt:now })
        return {schema_version:'commercial.receipt.v1',receipt}
      }
      case 'ops.commercial.receipt.unmatched.list':
        return {schema_version:'commercial.receipts.v1',...await receiptPage(params,'unmatched','',(limit,cursor)=>receipts.listUnmatched(limit,cursor ? {receivedAt:cursor.at,id:cursor.id}:undefined),row=>row.receivedAt)}
      case 'ops.commercial.receipt.unmatched.match': {
        const evidence = object(params, 'evidence_json')
        const customerRef = required(evidence, 'matched_customer_ref')
        if (!deps.validateMatchTarget) throw new DomainError('COMMERCIAL_MATCH_TARGET_UNAVAILABLE', '无法核验目标客户与企业关系', 503)
        await deps.validateMatchTarget(workspaceId, customerRef)
        return {schema_version:'commercial.receipt.v1',receipt:await receipts.matchUnmatched({receiptId:required(params,'receipt_id'),workspaceId,actorId,reason:required(params,'reason'),evidence,at:now})}
      }

      case 'ops.commercial.receipt.allocations.preview':
      case 'ops.commercial.receipt.allocations.confirm': {
        let rows: Params[]
        try { const parsed: unknown = JSON.parse(required(params, 'allocations_json')); if (!Array.isArray(parsed) || !parsed.length || parsed.length > 100 || parsed.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('invalid'); rows = parsed as Params[] }
        catch { throw new DomainError('INVALID_REQUEST', 'allocations_json 需要1到100项收款分配', 400) }
        const key = method.endsWith('.confirm') ? required(params, 'idempotency_key') : null
        const inputs = rows.map((row, index) => ({ workspaceId, receiptId: required(row, 'receipt_id'), orderId: required(row, 'order_id'), amountFen: integer(row, 'amount_fen'), expectedRevision: integer(row, 'expected_revision'), idempotencyKey: `${key}:${index}`, actorId, at: now }))
        if (key) {
          const prior = await Promise.all(inputs.map(input => receipts.getAllocationByIdempotencyKey(workspaceId, input.idempotencyKey)))
          if (prior.some(Boolean)) {
            if (await receipts.getAllocationByIdempotencyKey(workspaceId, `${key}:${inputs.length}`) || prior.some((fact, index) => !fact || fact.receiptId !== inputs[index]!.receiptId || fact.orderId !== inputs[index]!.orderId || fact.amountFen !== inputs[index]!.amountFen || fact.actorId !== actorId)) throw new DomainError('COMMERCIAL_RECEIPT_CONFLICT', '批次幂等键已绑定其他分配，请查询原意图', 409)
            return { schema_version: 'commercial.receipt.allocations.v1', allocations: prior.map(fact => fact!.result), replayed: true }
          }
        }
        const previews = await Promise.all(rows.map(row => handleCommercialReceiptMethod('ops.commercial.receipt.allocation.preview', { ...row, target_workspace_id: workspaceId }, deps))) as Params[]
        const preview = {actorId,workspaceId,previews:previews.map(({preview_hash: _token,expires_at: _deadline,schema_version: _schema,...detail})=>detail)}
        if (method.endsWith('.preview')) return { schema_version: 'commercial.receipt.allocations-preview.v1', items: previews, ...issueCommercialPreview(preview,'receipt-batch',deps.previewSigningKey) }
        confirmCommercialPreview(required(params,'preview_hash'),preview,'receipt-batch',deps.previewSigningKey)
        const allocations = await receipts.allocateBatchAndFulfill(inputs, deps.fulfill)
        return { schema_version: 'commercial.receipt.allocations.v1', allocations, replayed: false }
      }

      case 'ops.commercial.receipt.record': {
        if (params.source !== 'bank_transfer' || params.currency !== 'CNY') throw new DomainError('INVALID_REQUEST', '本期仅支持人民币银行转账核验', 400)
        const receipt = await receipts.record({ workspaceId, source: 'bank_transfer', receivingAccountRef: required(params, 'receiving_account_ref'), externalTradeId: required(params, 'external_trade_id'), payerRef: required(params, 'payer_ref'), amountFen: integer(params, 'amount_fen'), currency: 'CNY', receivedAt: required(params, 'received_at'), evidence: object(params, 'evidence_json'), actorId, verifiedAt: now })
        return { schema_version: 'commercial.receipt.v1', receipt }
      }
      case 'ops.commercial.receipt.list':
        return {schema_version:'commercial.receipts.v1',...await receiptPage(params,'matched',workspaceId,(limit,cursor)=>receipts.list(workspaceId,limit,cursor ? {receivedAt:cursor.at,id:cursor.id}:undefined),row=>row.receivedAt)}
      case 'ops.commercial.receipt.get': {
        const receipt = await receipts.get(workspaceId, required(params, 'receipt_id'))
        if (!receipt) throw new DomainError('COMMERCIAL_RECEIPT_NOT_FOUND', '收款记录不存在', 404)
        return { schema_version: 'commercial.receipt.v1', receipt }
      }
      case 'ops.commercial.receipt.allocation.preview':
      case 'ops.commercial.receipt.allocation.confirm': {
        const receiptId = required(params, 'receipt_id'), orderId = required(params, 'order_id')
        const amountFen = integer(params, 'amount_fen'), expectedRevision = integer(params, 'expected_revision')
        if (method.endsWith('.confirm')) {
          const prior = await receipts.getAllocationByIdempotencyKey(workspaceId, required(params, 'idempotency_key'))
          if (prior) {
            if (prior.receiptId !== receiptId || prior.orderId !== orderId || prior.amountFen !== amountFen || prior.actorId !== actorId) throw new DomainError('COMMERCIAL_RECEIPT_CONFLICT', '幂等键已绑定另一分配', 409)
            return { schema_version: 'commercial.receipt.allocation.v1', allocation: prior.result, replayed: true }
          }
        }
        const [receipt, payment, frozen, allocatedFen] = await Promise.all([receipts.get(workspaceId, receiptId), contracts.getPaymentStatus(workspaceId, orderId), contracts.getOrderSnapshot(workspaceId, orderId), receipts.getOrderAllocationTotal(workspaceId, orderId)])
        if (!receipt || !payment) throw new DomainError('COMMERCIAL_RECEIPT_NOT_FOUND', '收款或订单不存在', 404)
        if (receipt.revision !== expectedRevision) throw new DomainError('COMMERCIAL_RECEIPT_CONFLICT', '收款分配状态已变化，请重新预览', 409)
        if (amountFen > receipt.availableFen || amountFen > payment.order.amountFen - allocatedFen) throw new DomainError('COMMERCIAL_RECEIPT_INSUFFICIENT', '分配金额超过可用收款或订单金额', 409)
        const preview = { workspace_id: workspaceId, actor_id: actorId, receipt, order: { ...payment.order, snapshot: frozen?.snapshot ?? null }, allocated_before_fen: allocatedFen, allocated_after_fen: allocatedFen + amountFen, sku_code: payment.skuCode, amount_fen: amountFen, expected_revision: expectedRevision, available_after_fen: receipt.availableFen - amountFen, fulfillment_state: 'verification_required' }
        const token = method.endsWith('.preview') ? issueCommercialPreview(preview,'receipt-allocation',deps.previewSigningKey) : null
        if (method.endsWith('.preview')) return { schema_version: 'commercial.receipt.allocation-preview.v1', ...preview, ...token }
        confirmCommercialPreview(required(params,'preview_hash'),preview,'receipt-allocation',deps.previewSigningKey)
        const allocation = await receipts.allocateAndFulfill({ workspaceId, receiptId, orderId, amountFen, expectedRevision, idempotencyKey: required(params, 'idempotency_key'), actorId, at: now }, deps.fulfill)
        return { schema_version: 'commercial.receipt.allocation.v1', allocation, receipt: await receipts.get(workspaceId, receiptId), order: await contracts.getPaymentStatus(workspaceId, orderId) }
      }
      case 'ops.commercial.receipt.return.propose':
        return { schema_version: 'commercial.receipt.return.v1', item: await receipts.proposeReturn({ workspaceId, receiptId: required(params, 'receipt_id'), returnId: required(params, 'return_id'), amountFen: integer(params, 'amount_fen'), payerRef: required(params, 'payer_ref'), expectedRevision: integer(params, 'expected_revision'), actorId, reason: required(params, 'reason'), evidence: object(params, 'evidence_json'), at: now }) }
      case 'ops.commercial.receipt.return.decide': {
        const action = params.decision
        if (action !== 'approve' && action !== 'reject') throw new DomainError('INVALID_REQUEST', 'decision 必须为 approve 或 reject', 400)
        return { schema_version: 'commercial.receipt.return.v1', item: await receipts.decideReturn({ workspaceId, returnId: required(params, 'return_id'), actorId, action, evidence: object(params, 'evidence_json'), at: now }) }
      }
      case 'ops.commercial.receipt.return.complete': {
        const outcome = params.outcome
        if (outcome !== 'completed' && outcome !== 'unknown') throw new DomainError('INVALID_REQUEST', 'outcome 无效', 400)
        return { schema_version: 'commercial.receipt.return.v1', item: await receipts.completeReturn({ workspaceId, returnId: required(params, 'return_id'), actorId, outcome, ...(typeof params.external_return_id === 'string' ? { externalReturnId: params.external_return_id } : {}), evidence: object(params, 'evidence_json'), at: now }) }
      }
      case 'ops.commercial.receipt.return.list':
        return {schema_version:'commercial.receipt.returns.v1',...await receiptPage(params,'returns',workspaceId,(limit,cursor)=>receipts.listReturns(workspaceId,limit,cursor ? {createdAt:cursor.at,id:cursor.id}:undefined),row=>row.createdAt)}
      default: throw new DomainError('INVALID_REQUEST', '不支持的收款操作', 400)
    }
  } catch (error) {
    if (error instanceof CommercialReceiptError) throw new DomainError(error.code, error.message, error.code === 'COMMERCIAL_RECEIPT_NOT_FOUND' ? 404 : error.code === 'COMMERCIAL_RECEIPT_INVALID' ? 400 : 409, { business_reason: error.code, retryable: false, next_actions: ['ops.commercial.receipt.get'] })
    throw error
  }
}
