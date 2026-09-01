import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(import.meta.dirname, "../styles.css"), "utf8");

describe("OpsSidebar desktop interaction tokens", () => {
  it("keeps navigation colors centralized and preserves accessible targets", () => {
    expect(styles).toContain("--ops-nav-surface:");
    expect(styles).toContain("--ops-nav-active:");
    expect(styles).toContain("--ops-nav-focus:");
    expect(styles).toMatch(/\.sider-item\s*\{[^}]*min-height:\s*44px/s);
    expect(styles).toMatch(/\.sider-subitem\s*\{[^}]*min-height:\s*44px/s);
    expect(styles).toContain(".sider-item:focus-visible");
    expect(styles).toContain("outline: 3px solid var(--ops-nav-focus)");
  });

  it("keeps reduced-motion support in the desktop stylesheet", () => {
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain("transition-duration: .01ms");
    expect(styles).toContain("animation-duration: .01ms");
  });
});
