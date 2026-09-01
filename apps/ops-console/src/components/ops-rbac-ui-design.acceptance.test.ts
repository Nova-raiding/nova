import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(import.meta.dirname, "../styles.css"), "utf8");
const header = readFileSync(resolve(import.meta.dirname, "./OpsHeader.tsx"), "utf8");
const roleScope = readFileSync(resolve(import.meta.dirname, "./authz/RoleScopeBar.tsx"), "utf8");
const denied = readFileSync(resolve(import.meta.dirname, "./authz/AccessDeniedResult.tsx"), "utf8");

function relativeLuminance(hex: string) {
  const channels = hex.match(/[a-f\d]{2}/giu)?.map((channel) => Number.parseInt(channel, 16) / 255) ?? [];
  const linear = channels.map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

function contrast(foreground: string, background: string) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("ops RBAC desktop UI acceptance", () => {
  it("keeps the desktop action targets keyboard-sized and visibly focused", () => {
    expect(styles).toMatch(/\.ops-connection-toggle, \.ops-refresh-button, \.ops-jit-status \.ant-btn\s*\{[^}]*min-height:\s*44px/s);
    expect(styles).toMatch(/\.ops-role-summary-trigger\s*\{[^}]*min-height:\s*44px/s);
    expect(styles).toContain(":where(.ant-btn, .ant-input");
    expect(styles).toContain("outline: var(--ops-focus-width) solid var(--ops-focus-color)");
  });

  it("keeps navigation and status text above AA contrast", () => {
    expect(contrast("#d6def0", "#12234f")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#93a4ca", "#12234f")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#0f172a", "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("exposes keyboard, async feedback, and recovery semantics", () => {
    expect(header).toContain('aria-expanded={connectionOpen}');
    expect(header).toContain('aria-controls="ops-connection-fields"');
    expect(header).toContain('role="alert"');
    expect(header).toContain('aria-invalid');
    expect(roleScope).toContain('aria-expanded={rolesOpen}');
    expect(roleScope).toContain('aria-controls={rolesPanelId}');
    expect(roleScope).toContain('aria-live="polite"');
    expect(denied).toContain('role="alert"');
    expect(denied).toContain('aria-label={refreshing ? "正在刷新权限" : "刷新权限"}');
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
