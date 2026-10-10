import type { CustomerDeliveryRecord } from "../components/delivery/CustomerDeliverySection.js";

/**
 * A competing archive may have completed after the caller's first read. Treat
 * that latest archived record as success without writing another revision.
 */
export async function recoverCustomerDeliveryArchiveConflict(
  latest: CustomerDeliveryRecord,
  persist: (record: CustomerDeliveryRecord) => Promise<CustomerDeliveryRecord>,
): Promise<CustomerDeliveryRecord> {
  if (latest.archivedAt) return latest;
  return persist(latest);
}
