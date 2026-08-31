import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PlatformSummarySection, summarizePlatforms } from "./PlatformSummarySection.js";

const stores = [
  { platform: "jd", accountId: "a", label: "客户店铺 A", state: "connected", dataMode: "official_api", readable: true, writeEnabled: false, revision: 1 },
  { platform: "jd", accountId: "b", label: "客户店铺 B", state: "refresh_required", dataMode: "fixture", readable: true, writeEnabled: false, revision: 1 },
] as const;

describe("platform operations summary", () => {
  it("aggregates platform health without exposing store identities", () => {
    expect(summarizePlatforms([...stores])).toEqual([{ platform: "jd", storeCount: 2, officialApiCount: 1, attentionCount: 1 }]);
    const markup = renderToStaticMarkup(<PlatformSummarySection stores={[...stores]} platformLabels={{ jd: "京东" }} onOpenSupport={vi.fn()} />);
    expect(markup).toContain("平台连接汇总");
    expect(markup).toContain("京东");
    expect(markup).not.toContain("客户店铺 A");
    expect(markup).not.toContain("accountId");
  });

  it("renders explicit empty and error states", () => {
    const empty = renderToStaticMarkup(<PlatformSummarySection stores={[]} platformLabels={{}} onOpenSupport={vi.fn()} />);
    expect(empty).toContain("暂无平台连接汇总");
    const error = renderToStaticMarkup(<PlatformSummarySection stores={[]} error="权限不足" platformLabels={{}} onRetry={vi.fn()} onOpenSupport={vi.fn()} />);
    expect(error).toContain('role="alert"');
    expect(error).toContain("权限不足");
  });
});
