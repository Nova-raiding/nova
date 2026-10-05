/** Merchant intake: identity, workspace, customer and priority are server-owned. */
export interface MerchantSupportRequestInput {
  subject: string
  message: string
  idempotency_key: string
  request_id?: string
  trace_id?: string
  version?: string
  step?: string
}

export interface MerchantSupportRequestReceipt {
  ticket_id: string
  ticket_number: string
  status: 'open' | 'in_progress' | 'waiting_customer' | 'resolved' | 'closed'
  replayed: boolean
  replies_path: string
  submitted: true
}

/** All replies are customer-visible and the ticket must belong to the caller. */
export interface MerchantSupportRequestView extends MerchantSupportRequestReceipt {
  subject: string
  replies: readonly { id: string; body: string; created_at: string }[]
}
