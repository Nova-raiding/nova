import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const financeSource = readFileSync(new URL("./FinancePage.tsx", import.meta.url), "utf8");

describe("platform unmatched-receipt entry visibility", () => {
  it("mounts the read-only unmatched queue for order readers independently of receipt mutation grants", () => {
    expect(financeSource).toContain('{model.authorization.can("commercial.order.read") ? <UnmatchedCashOperationsPanel controller={commercial} /> : null}');
    expect(financeSource).toContain('{model.authorization.can("commercial.receipt.record") || model.authorization.can("commercial.receipt.allocate") ? <CashReceiptOperationsPanel controller={commercial} /> : null}');
  });
});
