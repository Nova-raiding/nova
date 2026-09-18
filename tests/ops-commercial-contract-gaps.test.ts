import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const model = readFileSync(new URL("../apps/ops-console/src/hooks/useOpsConsoleModel.ts", import.meta.url), "utf8");
const api = readFileSync(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
const offerTable = readFileSync(new URL("../apps/ops-console/src/components/finance/OfferTable.tsx", import.meta.url), "utf8");

describe("bounded Ops commercial contract gaps", () => {
  it("requires and audits an operator reason for both workspace lifecycle transitions", () => {
    expect(model).toContain('{ reason: reason.trim() }');
    const deactivate = api.slice(api.indexOf("case 'workspace.deactivate':"), api.indexOf("case 'workspace.activate':"));
    const activate = api.slice(api.indexOf("case 'workspace.activate':"), api.indexOf("case 'workspace.data.export.request':"));
    for (const transition of [deactivate, activate]) {
      expect(transition).toContain("required(params, 'reason')");
      expect(transition).toContain("recordOperationAudit");
    }
  });

  it("submits offer validity, revision and the operator-authored reason", () => {
    expect(model).toContain("valid_from: row.validFrom");
    expect(model).toContain("expected_revision: String(row.revision)");
    expect(model).toContain("reason: row.changeReason!.trim()");
    expect(model).toContain("失效时间必须晚于生效时间");
    expect(offerTable).toContain('type="datetime-local"');
    expect(offerTable).toContain("offerDateTimeIsoValue");
  });
});
