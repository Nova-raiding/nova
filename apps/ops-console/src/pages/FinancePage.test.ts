import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { catalogPriceYuan } from "./FinancePage.js";

const financeSource = readFileSync(new URL("./FinancePage.tsx", import.meta.url), "utf8");

describe("catalogPriceYuan", () => {
  it("uses the exact integer-fen amount instead of reparsing a localized label", () => {
    expect(catalogPriceYuan({ priceFen: 199_900, priceLabel: "¥1,999.00" })).toBe(1999);
  });

  it("supports legacy labels with thousands separators when priceFen is absent", () => {
    expect(catalogPriceYuan({ priceLabel: "¥ 5,000.50 / 月" })).toBe(5000.5);
  });

  it("fails closed to zero for an unresolved legacy price", () => {
    expect(catalogPriceYuan({ priceFen: null, priceLabel: "价格未决" })).toBe(0);
  });
});

describe("finance workspace context", () => {
  it("selects a tenant from the enterprise directory and labels the active scope", () => {
    expect(financeSource).toContain("model.workspaceRows.map(row => ({ value: row.workspaceId");
    expect(financeSource).toContain("allowedWorkspaceIds");
    expect(financeSource).toContain("useCommercialOperations(model.authorization, undefined, !isPlatformWorkbench || canOperateCrossWorkspaceCommercial, canReconcileCommercialRefund, allowedWorkspaceIds)");
    expect(financeSource).toContain('aria-label="商业目标企业主体"');
    expect(financeSource).toContain("当前企业：${selectedWorkspace?.enterpriseName || workspaceDraft}");
    expect(financeSource).not.toContain('placeholder="例如 ws_demo"');
  });

  it("exposes platform assisted purchase and verified cash allocation only through platform capabilities", () => {
    expect(financeSource).toContain('model.authorization.can("commercial.payment.reconcile") && model.authorization.can("commercial.order.read") ? <AssistedPurchaseOperationsPanel controller={commercial} /> : null');
    expect(financeSource).toContain('model.authorization.can("commercial.receipt.record") || model.authorization.can("commercial.receipt.allocate") ? <CashReceiptOperationsPanel controller={commercial} /> : null');
    expect(financeSource).toContain('aria-label="代购与收款目标企业主体"');
  });

  it("exposes recharge refunds in the platform workbench only with the server-projected refund capability", () => {
    expect(financeSource).toContain('{model.authorization.can("billing.refund.execute") ? <RefundSection model={model} /> : null}');
  });
});
