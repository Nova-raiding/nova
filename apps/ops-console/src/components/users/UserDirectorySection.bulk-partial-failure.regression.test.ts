import { describe, expect, it } from "vitest";
import { failedUserDirectorySelectionKeys } from "./UserDirectorySection.js";

describe("user directory partial bulk suspension", () => {
  it("retains only failed members, distinguishing identical subjects across workspaces", () => {
    const targets = [
      { workspaceId: "ws-a", externalSubject: "member-1", revision: 1 },
      { workspaceId: "ws-b", externalSubject: "member-1", revision: 8 },
      { workspaceId: "ws-c", externalSubject: "member-3", revision: 2 },
    ];
    const failedTargets = [targets[1]!, targets[2]!];
    const currentActionableTargets = [targets[2]!];

    expect(failedUserDirectorySelectionKeys(targets, failedTargets, currentActionableTargets)).toEqual([
      "merchant:ws-c:member-3",
    ]);
  });
});
