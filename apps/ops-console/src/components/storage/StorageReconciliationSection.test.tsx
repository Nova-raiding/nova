import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StorageReconciliationSection } from "./StorageReconciliationSection.js";

describe("StorageReconciliationSection accessibility states", () => {
  it("announces loading without discarding the reconciliation region", () => {
    const markup = renderToStaticMarkup(<StorageReconciliationSection loading />);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain("正在加载对账结果");
  });

  it("focuses and announces errors with a keyboard-sized retry action", () => {
    const onRetry = vi.fn();
    const markup = renderToStaticMarkup(<StorageReconciliationSection error="对账服务暂时不可用" onRetry={onRetry} />);
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-live="assertive"');
    expect(markup).toContain('aria-label="重试加载对账结果"');
    expect(markup).toContain("min-height:44px");
    expect(markup).toContain("对账服务暂时不可用");
  });
});
