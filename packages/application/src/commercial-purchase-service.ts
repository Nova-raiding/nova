import type { CommercialPaymentStatusRequest, CommercialPurchaseCreateRequest, CommercialPurchaseErrorCode, CommercialPurchaseOrderView } from '@merchant-marketing/contracts'

export interface ApprovedCommercialPurchaseSku {
  readonly code: string
  readonly kind: 'onboarding' | 'monthly' | 'point_pack' | 'private_trial'
  readonly version_id: string
  readonly lifecycle: 'approved'
  readonly executable: true
  readonly effective_at: string
  readonly blockers: readonly string[]
  /** Opaque server reference; never client-controlled. */
  readonly server_snapshot_ref: string
  /** Request-local server value returned by the catalog adapter, never accepted from client input. */
  readonly server_snapshot: unknown
}

export interface CommercialPurchaseCatalogPort {
  resolveApprovedExecutableSku(input: { workspace_id: string; sku_code: string; actor_id: string }): Promise<ApprovedCommercialPurchaseSku | null>
}

export interface CommercialPurchaseOrderPort {
  createFromServerSnapshot(input: { workspace_id: string; actor_id: string; purchase_kind: CommercialPurchaseCreateRequest['purchase_kind']; server_snapshot_ref: string; server_snapshot: unknown; idempotency_key: string; reason: string }): Promise<CommercialPurchaseOrderView>
  getPaymentStatus(input: CommercialPaymentStatusRequest): Promise<CommercialPurchaseOrderView | null>
}

export class CommercialPurchaseError extends Error {
  constructor(readonly code: CommercialPurchaseErrorCode, message: string) { super(message); this.name = 'CommercialPurchaseError' }
}

const required = (value: string, field: string) => { if (!value || value.trim() !== value) throw new TypeError(`${field} is required`); return value }

export class CommercialPurchaseService {
  constructor(private readonly catalog: CommercialPurchaseCatalogPort, private readonly orders: CommercialPurchaseOrderPort) {}

  async create(request: CommercialPurchaseCreateRequest): Promise<CommercialPurchaseOrderView> {
    required(request.workspace_id, 'workspace_id'); required(request.actor_id, 'actor_id'); required(request.sku_code, 'sku_code'); required(request.idempotency_key, 'idempotency_key'); required(request.reason, 'reason')
    const sku = await this.catalog.resolveApprovedExecutableSku({ workspace_id: request.workspace_id, sku_code: request.sku_code, actor_id: request.actor_id })
    if (!sku || sku.lifecycle !== 'approved' || sku.executable !== true || sku.blockers.length > 0 || !Number.isFinite(Date.parse(sku.effective_at)) || Date.parse(sku.effective_at) > Date.now()) {
      throw new CommercialPurchaseError('COMMERCIAL_PURCHASE_UNAVAILABLE', 'approved executable commercial SKU is unavailable')
    }
    if (sku.kind === 'private_trial') throw new CommercialPurchaseError('PRIVATE_PURCHASE_UNAVAILABLE', 'private purchase eligibility and accounting policy remain unresolved')
    const expected = request.purchase_kind === 'point_pack' ? 'point_pack' : 'monthly'
    if (sku.kind !== expected) throw new CommercialPurchaseError('COMMERCIAL_PURCHASE_KIND_MISMATCH', 'purchase kind does not match approved SKU kind')
    return this.orders.createFromServerSnapshot({ workspace_id: request.workspace_id, actor_id: request.actor_id, purchase_kind: request.purchase_kind, server_snapshot_ref: sku.server_snapshot_ref, server_snapshot: sku.server_snapshot, idempotency_key: request.idempotency_key, reason: request.reason })
  }

  async paymentStatus(request: CommercialPaymentStatusRequest): Promise<CommercialPurchaseOrderView> {
    required(request.workspace_id, 'workspace_id'); required(request.actor_id, 'actor_id'); required(request.order_id, 'order_id')
    const order = await this.orders.getPaymentStatus(request)
    if (!order) throw new CommercialPurchaseError('COMMERCIAL_ORDER_NOT_FOUND', 'commercial order was not found')
    return order
  }
}
