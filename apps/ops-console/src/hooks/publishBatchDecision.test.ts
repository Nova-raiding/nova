import { describe, expect, it } from "vitest";
import {
  normalizePublishBatchConfirmations,
  normalizePublishBatchPauseReason,
} from "./useOpsConsoleModel.js";

describe("Ops publish batch decisions", () => {
  it("requires a specific pause reason", () => {
    expect(() => normalizePublishBatchPauseReason(" abc ")).toThrow("至少填写 4 个字符");
    expect(normalizePublishBatchPauseReason("  平台回执异常待核对  ")).toBe("平台回执异常待核对");
  });

  it("normalizes a complete failed-item confirmation array", () => {
    const input = [{
      task_id: "task-1",
      content_version_id: "content-v2",
      confirmation_hash: "confirmation-v2",
      remote_snapshot_hash: "snapshot-v2",
      idempotency_key: "retry-task-1-v2",
    }];
    expect(normalizePublishBatchConfirmations(JSON.stringify(input))).toBe(JSON.stringify(input));
  });

  it.each([
    "not-json",
    "[]",
    JSON.stringify([{ task_id: "task-1" }]),
    JSON.stringify([{ task_id: "", content_version_id: "v", confirmation_hash: "c", remote_snapshot_hash: "s", idempotency_key: "k" }]),
  ])("rejects incomplete or unsafe retry confirmation input: %s", (value) => {
    expect(() => normalizePublishBatchConfirmations(value)).toThrow();
  });
});
