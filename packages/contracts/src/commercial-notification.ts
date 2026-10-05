/** Workspace and member identities are supplied only by verified server context. */
export interface CommercialNotificationView {
  id: string
  event_id: string
  sku_code: string
  version: number
  title: string
  body: string
  published_at: string
  payload: Record<string, unknown>
  notification_kind: 'catalog_publication' | 'purchase_result'
  read_at: string | null
  order_id?: string
  result_state?: 'active' | 'scheduled' | 'awaiting_dependency' | 'reconciliation_required'
}

export interface CommercialNotificationMarkReadRequest {
  notification_id: string
  idempotency_key: string
}

export interface CommercialNotificationMarkReadResult {
  notification_id: string
  read_at: string
  replayed: boolean
}
