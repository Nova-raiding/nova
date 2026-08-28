import { describe, expect, it, vi } from "vitest";
import { parseRevisionChangesJson, submitRevisionCreation } from "./revisionCreation.js";

describe("revision creation flow", () => {
  it("does not request or refresh when the modal is cancelled", async () => {
    const request = vi.fn();
    const refresh = vi.fn();
    await expect(submitRevisionCreation(undefined, { request, refresh })).resolves.toEqual({ created: false, cancelled: true });
    expect(request).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each(["", "{", "[]", "null", "{}"])("rejects invalid or empty changes before requesting: %j", async (changesJson) => {
    const request = vi.fn();
    const refresh = vi.fn();
    await expect(submitRevisionCreation({ publishJobId: "publish-1", changesJson, reason: "平台驳回后修正标题" }, { request, refresh })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("rejects an empty reason before requesting", async () => {
    const request = vi.fn();
    const refresh = vi.fn();
    await expect(submitRevisionCreation({ publishJobId: "publish-1", changesJson: '{"title":"合规新标题"}', reason: "   " }, { request, refresh })).rejects.toThrow("请填写创建修正版的原因");
    expect(request).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes only after a successful create request", async () => {
    const events: string[] = [];
    const request = vi.fn(async () => { events.push("request"); });
    const refresh = vi.fn(async () => { events.push("refresh"); });
    await expect(submitRevisionCreation({ publishJobId: "publish-1", changesJson: ' { "title": "合规新标题" } ', reason: " 平台驳回后修正标题 " }, { request, refresh })).resolves.toMatchObject({ created: true });
    expect(request).toHaveBeenCalledWith({ publish_job_id: "publish-1", changes_json: '{"title":"合规新标题"}', reason: "平台驳回后修正标题" });
    expect(events).toEqual(["request", "refresh"]);

    request.mockRejectedValueOnce(new Error("revision rejected"));
    await expect(submitRevisionCreation({ publishJobId: "publish-2", changesJson: '{"detail":"新详情"}', reason: "修正平台驳回字段" }, { request, refresh })).rejects.toThrow("revision rejected");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("returns a field-specific JSON validation message", () => {
    expect(() => parseRevisionChangesJson("[]")).toThrow("变更内容必须是 JSON 对象");
    expect(() => parseRevisionChangesJson("{}")).toThrow("至少填写一个需要修改的字段");
  });
});
