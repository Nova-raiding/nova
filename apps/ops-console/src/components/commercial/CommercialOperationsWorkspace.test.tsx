import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CommercialOperationsController } from "../../hooks/useCommercialOperations.js";
import { commercialBlockDisplayState, CommercialAccessStatusBar, CommercialErrorSummary, CommercialOperationsWorkspace } from "./CommercialOperationsWorkspace.js";

const query = { view: "blocks", record: "", status: "", query: "", page: 1, sort: "", order: "" } as const;

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
      query, setQuery: vi.fn(),
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
      query: { ...query, view: "catalog" }, setQuery: vi.fn(),
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

  it("keeps payment success blocked until a grant is present", () => {
    expect(commercialBlockDisplayState({ state: "BLOCKED", paymentState: "paid", grantState: "pending" })).toBe("PAID_BUT_UNGRANTED");
    expect(commercialBlockDisplayState({ state: "RECOVERED", paymentState: "paid", grantState: "granted" })).toBe("RECOVERED");
  });

  it("renders 409 revisions and evidence without dropping the operator context", () => {
    const html = renderToStaticMarkup(<CommercialErrorSummary error={{
      message: "记录已更新", code: "COMMERCIAL_REVISION_CONFLICT", httpStatus: 409,
      requestId: "req_409", traceId: "trace_409", details: { expected_revision: "rev_old", current_revision: "rev_new" },
      nextActions: ["refresh_decision"],
    }} onRetry={vi.fn()} />);
    expect(html).toContain("Revision conflict · 409");
    expect(html).toContain("rev_old");
    expect(html).toContain("rev_new");
    expect(html).toContain("req_409");
    expect(html).toContain("refresh_decision");
    expect(html).toContain('role="alert"');
  });

  it("keeps every commercial recovery state distinct with text and an icon", () => {
    const states = [
      ["EXHAUSTED", "CREATIVE_POINTS_EXHAUSTED", null, null],
      ["INSUFFICIENT", "CREATIVE_POINTS_INSUFFICIENT", null, null],
      ["UNAVAILABLE", "CREATIVE_POINTS_UNAVAILABLE", null, null],
      ["STALE", "COMMERCIAL_ACCESS_STALE", null, null],
      ["RATE_CARD_UNAVAILABLE", "RATE_CARD_UNAVAILABLE", null, null],
      ["BLOCKED", "CREATIVE_POINTS_UNAVAILABLE", "paid", "pending"],
      ["RECOVERED", "OK", "paid", "granted"],
    ].map(([state, errorCode, paymentState, grantState], index) => ({
      id: `block_${index}`, workspaceId: `ws_${index}`, state, errorCode,
      availablePoints: state === "EXHAUSTED" ? 0 : null, quotedPoints: null,
      accessRevision: `rev_${index}`, occurredAt: "2026-09-02T00:00:00.000Z", verifiedAt: null,
      paymentState, grantState, requestId: `req_${index}`, nextActions: [],
    }));
    const controller = {
      view: "blocks", setView: vi.fn(), loadSummary: vi.fn(), loadView: vi.fn(), query, setQuery: vi.fn(),
      summary: { status: "forbidden" },
      data: { blocks: { status: "ready", data: { total: states.length, items: states } }, entitlements: { status: "idle" }, ledger: { status: "idle" }, catalog: { status: "idle" }, orders: { status: "idle" }, rates: { status: "idle" }, services: { status: "idle" } },
      permissions: { privateSkuReadable: false, canRecover: false, canAdjustPoints: false, canDraftCatalog: false, canPublishCatalog: false, canGrantPrivateSku: false, canReconcilePayment: false, canDraftRate: false, canApproveRate: false, canWriteService: false },
    } as unknown as CommercialOperationsController;
    const html = renderToStaticMarkup(<CommercialOperationsWorkspace controller={controller} />);
    for (const label of ["EXHAUSTED", "INSUFFICIENT", "UNAVAILABLE", "STALE", "RATE_CARD_UNAVAILABLE", "PAID_BUT_UNGRANTED", "RECOVERED"]) expect(html).toContain(label);
    expect(html).toContain("anticon");
    expect(html).toContain("aria-sort");
  });
});
