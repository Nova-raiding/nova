import { describe, expect, it, vi } from "vitest";
import type { CustomerDeliveryRecord } from "../components/delivery/CustomerDeliverySection.js";
import { recoverCustomerDeliveryArchiveConflict, recoverCustomerDeliveryRestoreConflict } from "./customerDeliveryArchiveConflict.js";

const record = (archivedAt: string | null, revision: number): CustomerDeliveryRecord => ({
  id: "delivery-1",
  companyName: "Example",
  revision,
  archivedAt,
} as CustomerDeliveryRecord);

describe("customer delivery archive conflict recovery", () => {
  it("does not write again when a competing archive already completed", async () => {
    const firstArchive = record("2026-10-10T00:00:00.000Z", 2);
    const persist = vi.fn(async (candidate: CustomerDeliveryRecord) => candidate);

    const result = await recoverCustomerDeliveryArchiveConflict(firstArchive, persist);

    expect(result).toBe(firstArchive);
    expect(persist).not.toHaveBeenCalled();
    expect(result.archivedAt).toBe("2026-10-10T00:00:00.000Z");
    expect(result.revision).toBe(2);
  });

  it("retries an explicit archive using the latest revision when still active", async () => {
    const latest = record(null, 2);
    const persisted = record("2026-10-10T00:01:00.000Z", 3);
    const persist = vi.fn(async () => persisted);

    const result = await recoverCustomerDeliveryArchiveConflict(latest, persist);

    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith(latest);
    expect(result).toBe(persisted);
  });

  it("does not write again when a competing restore already completed", async () => {
    const restored = record(null, 3);
    const persist = vi.fn(async (candidate: CustomerDeliveryRecord) => candidate);

    const result = await recoverCustomerDeliveryRestoreConflict(restored, persist);

    expect(result).toBe(restored);
    expect(persist).not.toHaveBeenCalled();
    expect(result.archivedAt).toBeNull();
    expect(result.revision).toBe(3);
  });

  it("retries a restore using the latest revision when the record remains archived", async () => {
    const latest = record("2026-10-10T00:00:00.000Z", 3);
    const restored = record(null, 4);
    const persist = vi.fn(async () => restored);

    const result = await recoverCustomerDeliveryRestoreConflict(latest, persist);

    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith(latest);
    expect(result).toBe(restored);
  });
});
