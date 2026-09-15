import type { CommercialOrderPaymentStatusV2 } from '../../../packages/persistence/src/commercial-contract-repository.js'

export interface CommercialPaymentStatusReaderRepository {
  getPaymentStatus(workspaceId: string, orderId: string): Promise<CommercialOrderPaymentStatusV2 | null>
}

export interface OwnCommercialPaymentStatusInput {
  workspaceId: string
  orderId: string
  actorId?: string | null
}

const exactIdentifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.trim() === value

/** Self-scoped reads never inherit workspace-wide access from an administrator role. */
export async function readOwnCommercialPaymentStatus(
  repository: CommercialPaymentStatusReaderRepository,
  input: OwnCommercialPaymentStatusInput,
): Promise<CommercialOrderPaymentStatusV2 | null> {
  if (!exactIdentifier(input.workspaceId) || !exactIdentifier(input.orderId) || !exactIdentifier(input.actorId)) return null
  const status = await repository.getPaymentStatus(input.workspaceId, input.orderId)
  if (!status || status.order.workspaceId !== input.workspaceId || status.order.id !== input.orderId || status.order.createdByActorId !== input.actorId) return null
  return status
}
