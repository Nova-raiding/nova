import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import { marketingQueueCount, marketingQueueTabLabel, OperationalGovernanceSection } from "./OperationalGovernanceSection";

const EMPTY_QUEUE: OpsConsoleModel["marketingQueue"] = {
  generation: [],
  publish: [],
  visuals: [],
  batches: [],
  learningSuggestions: [],
  assetRisks: [],
  uploadedAssetRisks: [],
  imageExecutions: [],
};

function queueHarness({
  queue = EMPTY_QUEUE,
  loadedAt,
  error,
}: {
  queue?: OpsConsoleModel["marketingQueue"];
  loadedAt?: Date;
  error?: string;
}) {
  const model = {
    marketingQueue: queue,
    marketingQueueLoadedAt: loadedAt,
    dataSetError: (method: string) => (method === "ops.marketing.queue" ? error : undefined),
  } as unknown as OpsConsoleModel;
  return renderToStaticMarkup(<OperationalGovernanceSection model={model} />);
}

describe("OperationalGovernanceSection read state", () => {
  // Regression: the tab badge summed the model's empty queue seed, so a failed
  // or never-issued `ops.marketing.queue` read rendered 「任务队列（0）」 — the
  // same string a genuinely empty queue produces, on a page whose top-level
  // OpsPageError does not reach this badge.
  it("does not present a failed queue read as an empty queue", () => {
    const html = queueHarness({ error: "任务队列读取失败" });
    expect(html).toContain("任务队列（读取失败）");
    expect(html).not.toContain("任务队列（0）");
  });

  it("does not present a queue that was never read as an empty queue", () => {
    const html = queueHarness({});
    expect(html).toContain("任务队列（未读取）");
    expect(html).not.toContain("任务队列（0）");
  });

  it("still reports a measured zero once a queue read has landed", () => {
    const html = queueHarness({ loadedAt: new Date("2026-09-20T00:00:00Z") });
    expect(html).toContain("任务队列（0）");
    expect(html).not.toContain("未读取");
  });

  it("counts every queue list a landed read returned", () => {
    const html = queueHarness({
      queue: {
        ...EMPTY_QUEUE,
        batches: [
          { id: "b-1", itemCount: 3, state: "running", queuedCount: 2, failedCount: 1, updatedAt: "2026-09-20T00:00:00Z" },
        ],
        generation: [
          { id: "g-1", taskId: "t-1", state: "queued", attempt: 0, revision: 1, updatedAt: "2026-09-20T00:00:00Z" },
          { id: "g-2", taskId: "t-2", state: "failed", attempt: 2, revision: 1, updatedAt: "2026-09-20T00:00:00Z" },
        ],
        publish: [
          { id: "p-1", platform: "jd", taskId: "t-1", state: "queued", revision: 1, createdAt: "2026-09-20T00:00:00Z" },
        ],
      } as unknown as OpsConsoleModel["marketingQueue"],
      loadedAt: new Date("2026-09-20T00:00:00Z"),
    });
    expect(html).toContain("任务队列（4）");
    expect(marketingQueueCount(EMPTY_QUEUE)).toBe(0);
  });

  it("states the same three outcomes in the label helper", () => {
    expect(marketingQueueTabLabel(undefined, undefined)).toBe("任务队列（未读取）");
    expect(marketingQueueTabLabel(undefined, "任务队列读取失败")).toBe("任务队列（读取失败）");
    expect(marketingQueueTabLabel(0, undefined)).toBe("任务队列（0）");
    expect(marketingQueueTabLabel(7, undefined)).toBe("任务队列（7）");
  });
});
