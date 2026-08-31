import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RuleSyncStatusSection } from "./RuleSyncStatusSection.js";

describe("RuleSyncStatusSection", () => {
  it("shows stale platform evidence without presenting it as ready", () => {
    const html = renderToStaticMarkup(
      <RuleSyncStatusSection
        loading={false}
        onRefresh={() => undefined}
        statuses={[{
          platform: "douyin",
          label: "抖音",
          officialUrl: "https://example.test/rules",
          configured: true,
          machineReadable: false,
          latestVersion: "2026.08",
          sourceCheckedAt: "2026-08-20T00:00:00.000Z",
          ageHours: 216,
          stale: true,
          state: "stale",
          reason: "规则来源已超过 24 小时未检查",
        }]}
      />,
    );

    expect(html).toContain("1 个平台未通过规则新鲜度门禁");
    expect(html).toContain("已过期");
    expect(html).toContain("规则来源已超过 24 小时未检查");
  });
});
