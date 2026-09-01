import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CommercialOperationsController } from "../../hooks/useCommercialOperations.js";
import { CommercialAccessStatusBar, CommercialOperationsWorkspace } from "./CommercialOperationsWorkspace.js";

describe("CommercialOperationsWorkspace", () => {
  it("renders unknown as unavailable and never as zero", () => {
    const html = renderToStaticMarkup(<CommercialAccessStatusBar state={{ status: "ready", data: {
      decisionId: "cad_1", workspaceId: "ws_1", balanceState: "unknown", availablePoints: null,
      reservedPoints: null, quotedPoints: null, accessRevision: null, rateCardVersion: null,
      catalogVersion: null, errorCode: "CREATIVE_POINTS_UNAVAILABLE", allowed: false,
      earliestExpiresAt: null, verifiedAt: null, nextActions: [],
    } }} onRetry={vi.fn()} />);
    expect(html).toContain("CREATIVE_POINTS_UNAVAILABLE");
    expect(html).toContain("未知");
    expect(html).not.toContain("可用点数 </span><strong[^>]*>0");
  });

  it("defaults the rendered work queue to explicit blocked permission state", () => {
    const controller = {
      view: "blocks", setView: vi.fn(), loadSummary: vi.fn(), loadView: vi.fn(),
      summary: { status: "forbidden" },
      data: {
        blocks: { status: "forbidden" }, entitlements: { status: "idle" }, ledger: { status: "idle" },
        catalog: { status: "idle" }, orders: { status: "idle" }, rates: { status: "idle" }, services: { status: "idle" },
      },
      permissions: { privateSkuReadable: false, canRecover: false, canAdjustPoints: false, canDraftCatalog: false, canPublishCatalog: false, canGrantPrivateSku: false, canReconcilePayment: false, canDraftRate: false, canApproveRate: false, canWriteService: false },
    } as unknown as CommercialOperationsController;
    const html = renderToStaticMarkup(<CommercialOperationsWorkspace controller={controller} />);
    expect(html).toContain("阻断与恢复");
    expect(html).toContain("commercial.access.read");
    expect(html).toContain("BLOCKED");
    expect(html).not.toContain("人民币钱包");
  });

  it("does not render private SKU data without the private read capability", () => {
    const controller = {
      view: "catalog", setView: vi.fn(), loadSummary: vi.fn(), loadView: vi.fn(),
      summary: { status: "forbidden" },
      data: {
        blocks: { status: "idle" }, entitlements: { status: "idle" }, ledger: { status: "idle" },
        catalog: { status: "ready", data: { total: 2, items: [
          { id: "public", skuCode: "public_sku", name: "公开目录项", type: "plan", visibility: "public", version: "v1", priceLabel: "服务端价格", cycleLabel: null, benefitsSummary: "服务端权益", approvalState: "active", validFrom: null, validTo: null, unresolved: [] },
          { id: "secret", skuCode: "secret_private_sku", name: "不得泄露", type: "trial", visibility: "private", version: "v1", priceLabel: "服务端价格", cycleLabel: null, benefitsSummary: "服务端权益", approvalState: "draft", validFrom: null, validTo: null, unresolved: [] },
        ] } },
        orders: { status: "idle" }, rates: { status: "idle" }, services: { status: "idle" },
      },
      permissions: { privateSkuReadable: false, canRecover: false, canAdjustPoints: false, canDraftCatalog: false, canPublishCatalog: false, canGrantPrivateSku: false, canReconcilePayment: false, canDraftRate: false, canApproveRate: false, canWriteService: false },
    } as unknown as CommercialOperationsController;
    const html = renderToStaticMarkup(<CommercialOperationsWorkspace controller={controller} />);
    expect(html).toContain("public_sku");
    expect(html).not.toContain("secret_private_sku");
    expect(html).not.toContain("不得泄露");
  });
});
