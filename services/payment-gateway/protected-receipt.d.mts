export interface VerifiedNotifyReceiptInput {
  directory?: string
  providerSignatureVerified: boolean
  nativeSignature: string
  nativeSignedFields: string
  apiCallbackStatus: number
  callbackPath: string
  orderId: string
  providerTradeId: string
  workspaceId: string
  amountFen: number
  state: string
}

export interface VerifiedNotifyReceipt {
  schema_version: 'payment-gateway-source-receipt.v1'
  source: 'alipay_native_notify'
  observed_at: string
  request_id: string
  callback_path: string
  provider_signature_verified: true
  api_callback_status: number
  order_id_sha256: string
  provider_trade_id_sha256: string
  workspace_id_sha256: string
  native_signature_sha256: string
  native_signed_fields_sha256: string
  amount_fen: number
  state: string
  raw_body_stored: false
  final_evidence: false
}

export function captureVerifiedNotifyReceipt(input: VerifiedNotifyReceiptInput): VerifiedNotifyReceipt | null
