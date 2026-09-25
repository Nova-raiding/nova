import { DomainError } from '../../../packages/application/src/service.js'

/** Convert a ledger record to its public yuan representation. */
export function publicMoneyRecord<T extends { amountFen: number }>(record: T) {
  const { amountFen: _amountFen, ...withoutMinorUnit } = record
  return { ...withoutMinorUnit, amount_cny: (record.amountFen / 100).toFixed(2) }
}

/** Parse user-entered yuan without passing through floating-point arithmetic. */
export function parseCnyToFen(value: unknown, minimumFen = 100) {
  if (typeof value !== 'string' || !/^\d{1,8}(?:\.\d{1,2})?$/u.test(value.trim())) throw new DomainError('BILLING_AMOUNT_INVALID', '充值金额必须是合法的人民币金额', 400)
  const [yuan, fraction = ''] = value.trim().split('.')
  const fen = Number(yuan) * 100 + Number((fraction + '00').slice(0, 2))
  if (!Number.isSafeInteger(fen) || fen < minimumFen || fen > 1_000_000_00) throw new DomainError('BILLING_AMOUNT_INVALID', minimumFen === 1 ? '测试充值金额需在0.01元到100万元之间' : '充值金额需在1元到100万元之间', 400)
  return fen
}

/** Normalize binary floating-point noise before ceiling a model charge. */
export function scaleCnyToFen(value: number) {
  return Number((value * 100).toFixed(6))
}

/** Ceiling conversion for wallet charges, preserving the 1-fen platform minimum. */
export function chargeFenFromCny(value: number) {
  return Math.max(1, Math.ceil(scaleCnyToFen(value)))
}

export function walletBalanceFen<T extends { workspaceId: string; type: string; amountFen: number }>(workspaceId: string, transactions: readonly T[]) {
  return transactions.filter(item => item.workspaceId === workspaceId).reduce((sum, item) => sum + (item.type === 'debit' ? -item.amountFen : item.amountFen), 0)
}
