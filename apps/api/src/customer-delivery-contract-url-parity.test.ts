import { beforeEach, describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: network.lookup }));
vi.mock("node:https", async importOriginal => ({ ...await importOriginal<typeof import("node:https")>(), request: network.request }));

import { validateMcpRequest } from "../../../packages/contracts/src/mcp.js";
import { openCustomerDeliveryContractLink } from "../../ops-console/src/pages/CustomerDeliveryPage.js";
import { downloadCustomerDeliveryContract } from "./customer-delivery-contract-download.js";

const invalidUrls = [
  "https://files.example.test/%5c..%5cprivate.pdf",
  "https://files.example.test/contract\u202e.pdf",
];

describe("customer delivery contract URL syntax parity", () => {
  beforeEach(() => { network.lookup.mockReset(); network.request.mockReset(); });

  it.each(invalidUrls)("rejects %s in the Ops link control, MCP contract and server downloader", async url => {
    const openWindow = vi.fn();
    expect(() => openCustomerDeliveryContractLink(url, openWindow)).toThrow();
    expect(openWindow).not.toHaveBeenCalled();

    const mcp = validateMcpRequest({
      jsonrpc: "2.0", id: "contract-url-parity", method: "ops.customer-delivery.assets.upload",
      params: { target_workspace_id: "ws_url_parity", delivery_id: "delivery_url_parity", purpose: "contract", source_url: url },
    });
    expect(mcp.valid).toBe(false);
    expect(mcp.errors.join(" ")).not.toContain(url);

    await expect(downloadCustomerDeliveryContract(url)).rejects.toMatchObject({ code: "CUSTOMER_DELIVERY_CONTRACT_URL_INVALID", status: 400 });
    expect(network.lookup).not.toHaveBeenCalled();
    expect(network.request).not.toHaveBeenCalled();
  });
});
