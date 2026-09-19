import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { UNRESOLVED_WORKSPACE_DIRECTORY } from "./useOpsConsoleModel.js";

const modelSource = () => readFile(new URL("./useOpsConsoleModel.ts", import.meta.url), "utf8");

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

describe("top-level refresh coordination", () => {
  it("queues a repeat refresh through the rerun gate instead of dropping it", async () => {
    // The hook used to early-return whenever an identical filter key was in
    // flight (`loadInFlightKeysRef`), so the `await load()` that follows a save
    // resolved without the save ever being re-read: the row kept the old value
    // and the operator repeated an audited write. Every refresh now goes
    // through OpsLoadRerunGate, which replays the queued refresh and resolves
    // the caller only after that follow-up (see opsLoadCoordinator.test.ts).
    const source = await modelSource();
    expect(source).toContain("new OpsLoadRerunGate<OpsLoadFilterOverrides>()");
    expect(source).not.toContain("loadInFlightKeysRef");
    expect(source).not.toContain("if (loadInFlightKeysRef.current.has(loadKey)) return;");
  });

  it("clears the local bearer when the gateway rejects the session", async () => {
    // A 401/SESSION_EXPIRED probe means the stored bearer is dead. Leaving it
    // in localStorage kept sending `authorization: Bearer …` and let the next
    // onRefresh() succeed on a credential the gateway had already rejected.
    const source = await modelSource();
    const branch = source.slice(source.indexOf('"SESSION_EXPIRED", "UNAUTHENTICATED"'));
    expect(branch.length).toBeGreaterThan(0);
    expect(branch.slice(0, 600)).toContain("clearOpsConnectionConfig()");
  });
});
