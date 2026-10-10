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

/**
 * A competing restore may have completed after the caller's archive-list read.
 * Treat an already active record as success; otherwise retry using its latest
 * revision so the restore action does not replay a stale expected_revision.
 */
export async function recoverCustomerDeliveryRestoreConflict(
  latest: CustomerDeliveryRecord,
  persist: (record: CustomerDeliveryRecord) => Promise<CustomerDeliveryRecord>,
): Promise<CustomerDeliveryRecord> {
  if (latest.archivedAt === null) return latest;
  return persist(latest);
}
