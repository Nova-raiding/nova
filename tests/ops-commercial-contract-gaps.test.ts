import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const model = readFileSync(new URL("../apps/ops-console/src/hooks/useOpsConsoleModel.ts", import.meta.url), "utf8");
const workspaceGovernance = readFileSync(new URL("../apps/ops-console/src/components/users/WorkspaceGovernanceSection.tsx", import.meta.url), "utf8");
const offerTable = readFileSync(new URL("../apps/ops-console/src/components/finance/OfferTable.tsx", import.meta.url), "utf8");

describe("bounded Ops commercial contract gaps", () => {
  it("sends an operator reason for both workspace lifecycle transitions", () => {
    expect(model).toContain('{ reason: reason.trim() }');
    expect(workspaceGovernance).toContain('reasonMinimum = changingTo === "disabled" ? 4 : 1');
    expect(workspaceGovernance).toContain('"（必填）"');
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
