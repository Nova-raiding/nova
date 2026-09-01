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

  it("announces loading without replacing the last known status", () => {
    const html = renderToStaticMarkup(
      <RuleSyncStatusSection
        loading
        onRefresh={() => undefined}
        statuses={[{
          platform: "douyin",
          label: "抖音",
          officialUrl: "https://example.test/rules",
          configured: true,
          machineReadable: true,
          latestVersion: "2026.08",
          sourceCheckedAt: "2026-08-31T00:00:00.000Z",
          ageHours: 1,
          stale: false,
          state: "ready",
          reason: "规则来源在检查窗口内",
        }]}
      />,
    );

    expect(html).toContain('aria-label="六平台规则同步"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain("正在刷新六个平台规则同步状态，请稍候");
    expect(html).toContain('aria-label="正在刷新规则同步状态"');
    expect(html).toContain("2026.08");
  });

  it("keeps known statuses visible and exposes a focusable error recovery summary", () => {
    const html = renderToStaticMarkup(
      <RuleSyncStatusSection
        loading={false}
        error="规则服务暂时不可用"
        onRefresh={() => undefined}
        statuses={[{
          platform: "douyin",
          label: "抖音",
          officialUrl: "https://example.test/rules",
          configured: true,
          machineReadable: true,
          latestVersion: "2026.08",
          sourceCheckedAt: "2026-08-31T00:00:00.000Z",
          ageHours: 1,
          stale: false,
          state: "ready",
          reason: "规则来源在检查窗口内",
        }]}
      />,
    );

    expect(html).toContain('data-focus-target="error-summary"');
    expect(html).toContain('aria-label="规则同步错误摘要"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("规则服务暂时不可用");
    expect(html).toContain("重试规则同步");
    expect(html).toContain("2026.08");
  });
});
