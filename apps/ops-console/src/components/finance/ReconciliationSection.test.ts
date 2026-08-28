import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel.js";
import { ReconciliationSection } from "./ReconciliationSection.js";

const model = {
  reconciliation: undefined,
  canPaymentReconciliation: false,
  canModelSettlement: false,
  canBillingExport: false,
  runReconciliation: vi.fn(),
  runModelUsageReconciliation: vi.fn(),
  retryModelUsageSettlement: vi.fn(),
  waiveModelUsageSettlement: vi.fn(),
  markModelUsageForManualAttention: vi.fn(),
  exportBilling: vi.fn(),
} as unknown as OpsConsoleModel;

const renderSection = (overrides: Partial<OpsConsoleModel> = {}) =>
  renderToStaticMarkup(
    createElement(ReconciliationSection, {
      model: { ...model, ...overrides } as OpsConsoleModel,
    }),
  );

describe("ReconciliationSection finance actions", () => {
  it("hides billing export from roles without export permission", () => {
    expect(renderSection()).not.toContain("导出账单");
  });

  it("shows billing export to authorized finance roles", () => {
    expect(renderSection({ canBillingExport: true })).toContain("导出账单");
  });

  it("keeps model reconciliation enabled for platform_ops permissions", () => {
    const html = renderSection({ canModelSettlement: true });

    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>[^<]*<span>重试模型结算<\/span><\/button>/);
  });
});
