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

export interface GatewayOperationReceiptInput {
  directory?: string
  operation: 'checkout' | 'provider_query' | 'refund'
  orderId: string
  workspaceId: string
  amountFen: number
  outcome: string
  signedCheckoutParams?: string
  providerResponseSignatureVerified?: boolean
  providerTradeId?: string
  providerResponseReference?: string
  refundRequestId?: string
}

export interface GatewayOperationReceipt {
  schema_version: 'payment-gateway-operation-source-receipt.v1'
  source: 'alipay_signed_checkout' | 'alipay_verified_response'
  operation: GatewayOperationReceiptInput['operation']
  observed_at: string
  request_id: string
  order_id_sha256: string
  workspace_id_sha256: string
  provider_trade_id_sha256?: string
  provider_response_reference_sha256?: string
  refund_request_id_sha256?: string
  signed_checkout_params_sha256?: string
  amount_fen: number
  outcome: GatewayOperationReceiptInput['outcome']
  provider_response_signature_verified: boolean
  raw_body_stored: false
  final_evidence: false
}

export function captureGatewayOperationReceipt(input: GatewayOperationReceiptInput): GatewayOperationReceipt | null
