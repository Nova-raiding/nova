import { describe, expect, it, vi } from "vitest";
import {
  normalizeDataDeletionReason,
  submitDataDeletionDecision,
} from "./useOpsConsoleModel.js";

describe("Ops data deletion decisions", () => {
  it("rejects vague reasons before issuing an RPC", async () => {
    const request = vi.fn();
    const refresh = vi.fn();

    await expect(
      submitDataDeletionDecision({
        decision: "approve",
        requestId: "deletion-1",
        reason: "  abc  ",
        request,
        refresh,
      }),
    ).rejects.toThrow("至少 4 个字符");

    expect(request).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each(["approve", "cancel"] as const)(
    "passes the operator reason to the %s RPC and refreshes after success",
    async (decision) => {
      const request = vi.fn().mockResolvedValue({});
      const refresh = vi.fn().mockResolvedValue(undefined);

      await submitDataDeletionDecision({
        decision,
        requestId: "deletion-2",
        reason: "  已复核业务依据  ",
        request,
        refresh,
      });

      expect(request).toHaveBeenCalledWith(`ops.data.delete.${decision}`, {
        request_id: "deletion-2",
        reason: "已复核业务依据",
      });
      expect(refresh).toHaveBeenCalledOnce();
      expect(request.mock.invocationCallOrder[0]).toBeLessThan(
        refresh.mock.invocationCallOrder[0]!,
      );
    },
  );

  it("does not refresh when the decision RPC fails", async () => {
    const failure = new Error("审批冲突");
    const refresh = vi.fn();

    await expect(
      submitDataDeletionDecision({
        decision: "approve",
        requestId: "deletion-3",
        reason: "独立审批证据完整",
        request: vi.fn().mockRejectedValue(failure),
        refresh,
      }),
    ).rejects.toBe(failure);

    expect(refresh).not.toHaveBeenCalled();
  });

  it("normalizes surrounding whitespace without weakening the minimum", () => {
    expect(normalizeDataDeletionReason("  四字符原因  ")).toBe("四字符原因");
  });
});
