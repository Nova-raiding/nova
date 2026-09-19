import { describe, expect, it } from "vitest";
import { UNRESOLVED_WORKSPACE_DIRECTORY } from "./useOpsConsoleModel.js";

describe("workspace directory seed", () => {
  it("carries no total so an unread directory is not a measured zero", () => {
    // `useOpsConsoleModel` seeds and resets `workspaceDirectory` with this
    // object. When it carried `total: 0`, the platform overview rendered
    // 「客户总数 0 家」 while `ops.workspaces.list` was still pending or had
    // failed — a measured-looking zero for a read that never happened.
    expect(UNRESOLVED_WORKSPACE_DIRECTORY.total).toBeUndefined();
    expect(Object.keys(UNRESOLVED_WORKSPACE_DIRECTORY)).not.toContain("total");
    expect(UNRESOLVED_WORKSPACE_DIRECTORY.items).toEqual([]);
  });

  it("keeps the resolved-zero path available", () => {
    // A directory the server really answered still reports a number, so the
    // overview can render a genuine 0 as 0 rather than "—".
    const answered = { ...UNRESOLVED_WORKSPACE_DIRECTORY, total: 0 };
    expect(answered.total).toBe(0);
    expect(answered.total === undefined).toBe(false);
  });
});
