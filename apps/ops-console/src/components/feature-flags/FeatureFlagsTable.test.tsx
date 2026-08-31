import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FeatureFlagsTable } from "./FeatureFlagsTable";
import { FeatureFlagEnvironmentSelect, featureFlagDateTimeInput, featureFlagEnvironmentOptions, parseFeatureFlagValue } from "./FeatureFlagEditor";

const flag = { id: "f1", key: "checkout.new_flow", environment: "production", description: "New checkout", defaultValue: { type: "boolean" as const, value: true }, enabled: false, emergencyDisabled: false, targets: [], revision: 1, createdBy: "ops", updatedBy: "ops", createdAt: "2026-08-29T00:00:00Z", updatedAt: "2026-08-29T00:00:00Z" };
describe("Feature Flags UI", () => {
  it("renders accessible empty and permission-aware actions", () => {
    const readOnly = renderToStaticMarkup(<FeatureFlagsTable items={[flag]} loading={false} canWrite={false} canEmergency={false} onEdit={vi.fn()} onAudit={vi.fn()} onEmergency={vi.fn()} />);
    expect(readOnly).toContain('aria-label="功能开关列表"'); expect(readOnly).toContain('aria-label="查看 checkout.new_flow 审计"'); expect(readOnly).not.toContain('aria-label="紧急关闭 checkout.new_flow"'); expect(readOnly).not.toContain('aria-label="编辑 checkout.new_flow"');
    const writable = renderToStaticMarkup(<FeatureFlagsTable items={[flag]} loading={false} canWrite canEmergency onEdit={vi.fn()} onAudit={vi.fn()} onEmergency={vi.fn()} />);
    expect(writable).toContain('aria-label="紧急关闭 checkout.new_flow"'); expect(writable).toContain('aria-label="编辑 checkout.new_flow"');
  });
  it("renders the seeded local flag and gives local_demo a clear label", () => {
    const seededFlag = { ...flag, id: "fixture", key: "demo.fixture.ops_readiness", environment: "local_demo", description: "Local readiness fixture" };
    const markup = renderToStaticMarkup(<FeatureFlagsTable items={[seededFlag]} loading={false} canWrite={false} canEmergency={false} onEdit={vi.fn()} onAudit={vi.fn()} onEmergency={vi.fn()} />);
    expect(markup).toContain("demo.fixture.ops_readiness");
    expect(markup).toContain("local_demo");
    expect(featureFlagEnvironmentOptions(["local_demo"])).toEqual([{ value: "local_demo", label: "本地演示（local_demo）" }]);
  });
  it("labels the local environment control for assistive technology", () => {
    const markup = renderToStaticMarkup(<FeatureFlagEnvironmentSelect environments={["local_demo"]} value="local_demo" />);
    expect(markup).toContain('aria-label="功能开关环境"');
    expect(markup).toContain("本地演示（local_demo）");
  });
  it("accepts only typed non-executable values and enforces 16KiB", () => {
    expect(parseFeatureFlagValue("boolean", "false")).toBe(false); expect(parseFeatureFlagValue("number", "2.5")).toBe(2.5); expect(parseFeatureFlagValue("json", '{"segment":"vip"}')).toEqual({ segment: "vip" });
    expect(() => parseFeatureFlagValue("number", "script()")).toThrow("有效数字"); expect(() => parseFeatureFlagValue("json", '"script()"')).toThrow("对象或数组"); expect(() => parseFeatureFlagValue("string", "x".repeat(17 * 1024))).toThrow("16KiB");
  });
  it("round-trips validity windows without changing the instant", () => {
    const instant = "2026-09-01T03:04:00.000Z";
    expect(new Date(featureFlagDateTimeInput(instant)!).toISOString()).toBe(instant);
  });
});
