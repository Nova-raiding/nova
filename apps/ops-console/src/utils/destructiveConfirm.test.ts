import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OPS_CONFIRM_RISK,
  confirmFocusForRisk,
  confirmPolicyPropsFor,
  requiresConfirmation,
  resolveConfirmAutoFocus,
  type OpsConfirmAction,
} from "./destructiveConfirm.js";

const sourceFiles = [
  "../hooks/useOpsConsoleModel.ts",
  "../components/delivery/CustomerDeliverySection.tsx",
  "../components/tasks/knowledge/MarketingQueuePanel.tsx",
  "../components/finance/RefundSection.tsx",
];

describe("antd confirm focus default", () => {
  it("pins the shipped fallback the ops console has to opt out of", () => {
    // Read the installed antd instead of trusting the docs: this is the exact
    // line that puts keyboard focus on the danger button when nobody passes
    // `focusable.autoFocusButton`.
    const confirmDialog = readFileSync(
      resolve(import.meta.dirname, "../../../../node_modules/antd/es/modal/ConfirmDialog.js"),
      "utf8",
    );
    expect(confirmDialog).toContain("const base = focusable?.autoFocusButton || autoFocusButton;");
    expect(confirmDialog).toContain("return base || base === null ? base : 'ok';");
    // ActionButton then focuses that button from a setTimeout.
    const actionButton = readFileSync(
      resolve(import.meta.dirname, "../../../../node_modules/antd/es/_util/ActionButton.js"),
      "utf8",
    );
    expect(actionButton).toContain("buttonRef.current?.focus({");
  });

  it("reproduces the fallback so a silent antd change fails here", () => {
    expect(resolveConfirmAutoFocus()).toBe("ok");
    expect(resolveConfirmAutoFocus({})).toBe("ok");
    expect(resolveConfirmAutoFocus({ focusable: {} })).toBe("ok");
    expect(resolveConfirmAutoFocus({ autoFocusButton: null })).toBeNull();
  });

  it("prefers the non-deprecated focusable field over the legacy prop", () => {
    expect(resolveConfirmAutoFocus({ focusable: { autoFocusButton: "cancel" } })).toBe("cancel");
    expect(resolveConfirmAutoFocus({ focusable: { autoFocusButton: "cancel" }, autoFocusButton: "ok" })).toBe("cancel");
    // The legacy top-level prop still works but is deprecated in antd 6.
    expect(resolveConfirmAutoFocus({ autoFocusButton: "cancel" })).toBe("cancel");
  });
});

describe("ops confirmation risk policy", () => {
  it("focuses cancel for destructive actions and ok elsewhere", () => {
    expect(confirmFocusForRisk("destructive")).toBe("cancel");
    expect(confirmFocusForRisk("additive")).toBe("ok");
    expect(confirmFocusForRisk("read-only")).toBe("ok");
  });

  it("requires a confirmation for every action that changes server state", () => {
    expect(requiresConfirmation("destructive")).toBe(true);
    expect(requiresConfirmation("additive")).toBe(true);
    expect(requiresConfirmation("read-only")).toBe(false);
  });

  it("turns every destructive action into a cancel-first danger dialog", () => {
    for (const action of ["store.revoke", "billing.refund", "delivery.record.archive"] as const) {
      const props = confirmPolicyPropsFor(action);
      expect(props.focusable?.autoFocusButton).toBe("cancel");
      expect(resolveConfirmAutoFocus(props)).toBe("cancel");
      expect(props.okButtonProps?.danger).toBe(true);
    }
  });

  it("resolves every classified action to its declared focus", () => {
    for (const action of Object.keys(OPS_CONFIRM_RISK) as OpsConfirmAction[]) {
      expect(resolveConfirmAutoFocus(confirmPolicyPropsFor(action))).toBe(
        confirmFocusForRisk(OPS_CONFIRM_RISK[action]),
      );
    }
  });

  it("classifies the money and authorization paths as destructive", () => {
    expect(OPS_CONFIRM_RISK["store.revoke"]).toBe("destructive");
    expect(OPS_CONFIRM_RISK["billing.refund"]).toBe("destructive");
    expect(OPS_CONFIRM_RISK["delivery.record.archive"]).toBe("destructive");
    expect(confirmPolicyPropsFor("billing.refund").okButtonProps?.danger).toBe(true);
    expect(confirmPolicyPropsFor("store.revoke").focusable?.autoFocusButton).toBe("cancel");
  });

  it("leaves the reconciliation query and ticket creation on the default focus", () => {
    // 查单 is idempotent and self-healing, and a support ticket is additive:
    // neither should wear danger styling nor steal Enter away from the operator.
    for (const action of ["billing.reconciliation.run", "support.ticket.create"] as const) {
      expect(confirmPolicyPropsFor(action)).toEqual({});
      expect(resolveConfirmAutoFocus(confirmPolicyPropsFor(action))).toBe("ok");
    }
  });

  it("requires every confirm site in the console to be classified", () => {
    const used = sourceFiles.flatMap((file) => {
      const text = readFileSync(resolve(import.meta.dirname, file), "utf8");
      return [...text.matchAll(/confirmPolicyPropsFor\("([^"]+)"\)/gu)].map((match) => match[1]);
    });
    expect(new Set(used)).toEqual(new Set(Object.keys(OPS_CONFIRM_RISK)));
  });
});
