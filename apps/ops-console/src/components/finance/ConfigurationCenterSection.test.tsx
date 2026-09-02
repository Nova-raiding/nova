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
});
