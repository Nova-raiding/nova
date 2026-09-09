import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(__dirname, "ConfigurationCenterSection.tsx"), "utf8");

describe("ConfigurationCenterSection error recovery", () => {
  it("moves focus to a recoverable error summary", () => {
    expect(source).toContain("configurationErrorRef.current?.focus({ preventScroll: true })");
    expect(source).toContain('tabIndex={-1}');
    expect(source).toContain('role="alert"');
    expect(source).toContain('aria-label="配置中心错误摘要"');
  });

  it("provides a keyboard-sized refresh action", () => {
    expect(source).toContain('onClick={() => void model.load()}');
    expect(source).toContain('aria-label="刷新配置中心"');
    expect(source).toContain('style={{ minHeight: 44 }}');
  });

  it("clearly separates display settings from real OAuth authorization", () => {
    expect(source).toContain('title="此处不是 OAuth 授权配置"');
    expect(source).toContain("平台 AppKey/Secret、OAuth 回调、Vault 凭据及真实 API 能力由部署环境配置");
    expect(source).toContain("真实状态以平台上线 readiness 和授权审计为准");
    expect(source).toContain("未配置或未验证时系统会保持只读并阻断发布");
  });
});
