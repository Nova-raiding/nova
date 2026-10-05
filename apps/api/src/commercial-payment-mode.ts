import { DomainError } from '../../../packages/application/src/service.js'
export interface CommercialTransferInstructions { receiver_name: string; receiving_account: string; bank_name?: string; reference: string; warning: string }
/** Manual transfer is independently approved; enabling an online gateway is not its readiness. */
export function resolveCommercialPaymentMode(source: NodeJS.ProcessEnv, production: boolean): 'manual_transfer' | 'alipay' | 'wechat' | 'sandbox' {
  const provider = source.COMMERCIAL_PAYMENT_PROVIDER?.trim()
  if (provider === 'manual_transfer') {
    if (source.COMMERCIAL_MANUAL_TRANSFER_APPROVED !== 'true' || !source.COMMERCIAL_TRANSFER_RECEIVER_NAME?.trim() || !source.COMMERCIAL_TRANSFER_RECEIVING_ACCOUNT?.trim() || !source.COMMERCIAL_TRANSFER_VERIFICATION_POLICY?.trim()) {
      throw new DomainError('COMMERCIAL_PAYMENT_PROVIDER_UNAVAILABLE', '银行转账收款账户或核验策略尚未批准配置', 503, { blockers: ['manual_transfer_receiver_and_verification_policy_required'], retryable: false })
    }
    return provider
  }
  if (provider === 'alipay' || provider === 'wechat') {
    if (source.PAYMENT_MODE !== 'provider') throw new DomainError('COMMERCIAL_PAYMENT_PROVIDER_UNAVAILABLE', '所选线上支付渠道尚未配置', 503)
    return provider
  }
  if (!production && provider === 'sandbox' && source.NODE_ENV === 'test') return provider
  throw new DomainError('COMMERCIAL_PAYMENT_PROVIDER_UNAVAILABLE', '未配置已批准的商业支付模式', 503)
}
export function commercialTransferInstructions(source: NodeJS.ProcessEnv, reference: string): CommercialTransferInstructions {
  resolveCommercialPaymentMode(source, source.NODE_ENV === 'production')
  return { receiver_name: source.COMMERCIAL_TRANSFER_RECEIVER_NAME!.trim(), receiving_account: source.COMMERCIAL_TRANSFER_RECEIVING_ACCOUNT!.trim(), ...(source.COMMERCIAL_TRANSFER_BANK_NAME?.trim() ? { bank_name: source.COMMERCIAL_TRANSFER_BANK_NAME.trim() } : {}), reference, warning: '转账后由授权运营核实实际到账并分配至订单；上传截图或点击支付不代表已开通。' }
}
