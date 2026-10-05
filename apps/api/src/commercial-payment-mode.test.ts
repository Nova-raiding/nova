import { describe, expect, it } from 'vitest'
import { resolveCommercialPaymentMode, commercialTransferInstructions } from './commercial-payment-mode.js'
const manual = { COMMERCIAL_PAYMENT_PROVIDER: 'manual_transfer', COMMERCIAL_MANUAL_TRANSFER_APPROVED: 'true', COMMERCIAL_TRANSFER_RECEIVER_NAME: '已批准收款主体', COMMERCIAL_TRANSFER_RECEIVING_ACCOUNT: 'receiver-reference', COMMERCIAL_TRANSFER_VERIFICATION_POLICY: 'bank-receipt-v1' }
describe('independently approved commercial payment mode', () => {
  it('permits approved bank transfer without an online gateway', () => { expect(resolveCommercialPaymentMode({ ...manual, PAYMENT_MODE: 'disabled' }, true)).toBe('manual_transfer') })
  it.each(['COMMERCIAL_MANUAL_TRANSFER_APPROVED', 'COMMERCIAL_TRANSFER_RECEIVER_NAME', 'COMMERCIAL_TRANSFER_RECEIVING_ACCOUNT', 'COMMERCIAL_TRANSFER_VERIFICATION_POLICY'])('fails closed when %s is missing', field => { expect(() => resolveCommercialPaymentMode({ ...manual, [field]: '' }, true)).toThrow('银行转账') })
  it.each(['sandbox', 'arbitrary_provider'])('rejects production mode %s', provider => { expect(() => resolveCommercialPaymentMode({ ...manual, COMMERCIAL_PAYMENT_PROVIDER: provider }, true)).toThrow('已批准') })
  it('does not pretend the transfer instructions are an online payment URL', () => { expect(commercialTransferInstructions(manual, 'order-1')).toMatchObject({ reference: 'order-1', receiving_account: 'receiver-reference' }); expect(commercialTransferInstructions(manual, 'order-1')).not.toHaveProperty('payment_url') })
})
