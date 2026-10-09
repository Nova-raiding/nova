import { describe, expect, it, vi } from "vitest";
import { customerDeliveryContractSource, ensureCustomerDeliveryContractAsset } from "./CustomerDeliveryPage.js";
import type { CustomerDeliveryAsset } from "../api/customerDeliveryClient.js";

describe("customer delivery contract source regression", () => {
  it("supports either a selected file or a server-validated HTTPS direct link", () => {
    const file = new File(["pdf"], "contract.pdf", { type: "application/pdf" });
    expect(customerDeliveryContractSource("contract.pdf", file)).toEqual({ kind: "file", file, cacheKey: file });
    expect(customerDeliveryContractSource(" https://files.example.test/contract.pdf?sig=abc ")).toEqual({
      kind: "url",
      sourceUrl: "https://files.example.test/contract.pdf?sig=abc",
      cacheKey: "https://files.example.test/contract.pdf?sig=abc",
    });
    expect(() => customerDeliveryContractSource("http://files.example.test/contract.pdf")).toThrow("HTTPS");
    expect(() => customerDeliveryContractSource("https://user:pass@files.example.test/contract.pdf")).toThrow("登录凭据");
  });

  it("resumes a pending scan from the same isolated asset without uploading again", async () => {
    const source = customerDeliveryContractSource("https://files.example.test/contract.pdf");
    const attempt: { contract?: { sourceKey: File | string; assetRef: string } } = {};
    const pending: CustomerDeliveryAsset = { assetRef: "asset-contract-1", name: "contract.pdf", mimeType: "application/pdf", sizeBytes: 42, scanStatus: "pending", ready: false };
    const clean: CustomerDeliveryAsset = { ...pending, scanStatus: "clean", ready: true };
    const upload = vi.fn(async () => pending);
    const getAsset = vi.fn(async () => pending);
    const wait = vi.fn(async (asset: CustomerDeliveryAsset) => {
      if (wait.mock.calls.length === 1) throw new Error("scan pending");
      return clean;
    });
    const input = { attempt, source, targetWorkspaceId: "ws-a", deliveryId: "delivery-a", signal: new AbortController().signal, upload: upload as never, getAsset: getAsset as never, wait: wait as never };

    await expect(ensureCustomerDeliveryContractAsset(input)).rejects.toThrow("scan pending");
    expect(attempt.contract).toEqual({ sourceKey: source.cacheKey, assetRef: pending.assetRef });
    await expect(ensureCustomerDeliveryContractAsset(input)).resolves.toBe(clean.assetRef);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(getAsset).toHaveBeenCalledTimes(1);
  });
});
