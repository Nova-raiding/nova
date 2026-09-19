import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Acceptance coverage for the confirmation surfaces that guard destructive
 * operations. It asserts the shipped call sites, because the failure mode
 * (a danger dialog whose default focus is the danger button) cannot be
 * reproduced without a DOM: antd resolves the focus internally, see
 * `destructiveConfirm.test.ts` for the mirrored resolution rule.
 */
const read = (relative: string) => readFileSync(resolve(import.meta.dirname, relative), "utf8");

const hook = read("../hooks/useOpsConsoleModel.ts");
const refundSection = read("../components/finance/RefundSection.tsx");
const deliverySection = read("../components/delivery/CustomerDeliverySection.tsx");
const marketingQueue = read("../components/tasks/knowledge/MarketingQueuePanel.tsx");

/** Body of the first function whose signature contains `signature`, braces balanced. */
function functionBody(text: string, signature: string): string {
  const start = text.indexOf(signature);
  if (start < 0) throw new Error(`missing function: ${signature}`);
  // Skip the parameter list so destructured params (`(values: { orderId })`) are
  // not mistaken for the body.
  let cursor = text.indexOf("(", start);
  let parens = 0;
  for (; cursor >= 0 && cursor < text.length; cursor += 1) {
    if (text[cursor] === "(") parens += 1;
    else if (text[cursor] === ")") {
      parens -= 1;
      if (parens === 0) break;
    }
  }
  const open = text.indexOf("{", cursor);
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open, index + 1);
    }
  }
  throw new Error(`unbalanced body: ${signature}`);
}

const revokeStore = functionBody(hook, "const revokeStore = async");
const refund = functionBody(hook, "const refund = async");
const runReconciliation = functionBody(hook, "const runReconciliation = async");

describe("destructive confirmation call sites", () => {
  it("keeps the keyboard off the confirm button when revoking a store authorization", () => {
    expect(revokeStore).toContain('confirmPolicyPropsFor("store.revoke")');
  });

  it("keeps the keyboard off the confirm button when creating a refund", () => {
    expect(refund).toContain('confirmPolicyPropsFor("billing.refund")');
  });

  it("confirms a refund exactly once: one layer in refund(), none in the form", () => {
    // The single layer protects programmatic callers too; the form used to open
    // a second dialog whose onOk returned a promise, so antd kept the first one
    // loading underneath and cancelling the second closed both with no feedback.
    expect(refund.match(/modal\.confirm\(/gu)).toHaveLength(1);
    expect(refundSection).not.toContain("Modal.confirm");
    expect(refundSection).toContain("refund(values)");
  });

  it("states that a cancelled refund created no billing entry", () => {
    expect(refund).toContain("已取消退款");
    expect(refund).toContain("message.info(");
  });

  it("keeps the keyboard off the confirm button when archiving a delivery record", () => {
    expect(deliverySection).toContain('confirmPolicyPropsFor("delivery.record.archive")');
  });

  it("still classifies the read-only reconciliation query without destructive styling", () => {
    expect(runReconciliation).toContain('confirmPolicyPropsFor("billing.reconciliation.run")');
    expect(runReconciliation).not.toContain("autoFocusButton");
    expect(runReconciliation).not.toContain("danger: true");
  });

  it("still classifies support ticket creation without destructive styling", () => {
    expect(marketingQueue).toContain("创建工单");
    expect(marketingQueue).not.toContain("autoFocusButton");
    expect(marketingQueue).not.toContain("danger: true");
  });
});
