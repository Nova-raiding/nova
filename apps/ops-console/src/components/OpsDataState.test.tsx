import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OpsDataState, OpsEmptyState, OpsErrorState, OpsLoadingState } from "./OpsDataState.js";

describe("shared operations data states", () => {
  it("announces loading without presenting it as completed data", () => {
    const markup = renderToStaticMarkup(<OpsLoadingState label="正在加载审计记录" />);
    expect(markup).toContain('data-state="loading"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('aria-label="正在加载审计记录"');
  });

  it("renders explicit empty and error semantics with a named retry", () => {
    const empty = renderToStaticMarkup(<OpsEmptyState description="当前筛选条件下没有记录" />);
    const error = renderToStaticMarkup(<OpsErrorState description="运营 API 暂时不可用" onRetry={() => undefined} retryLabel="重试审计记录" />);
    expect(empty).toContain('data-state="empty"');
    expect(empty).toContain("当前筛选条件下没有记录");
    expect(error).toContain('data-state="error"');
    expect(error).toContain('role="alert"');
    expect(error).toContain('aria-label="重试审计记录"');
    expect(error).toContain('style="min-height:44px"');
    expect(error).toContain('tabindex="-1"');
    expect(error).toContain('data-focus-target="error-summary"');
    expect(error).toContain("aria-labelledby=");
    expect(error).toContain("aria-describedby=");
  });

  it("keeps an error recoverable when no page-specific retry callback exists", () => {
    const markup = renderToStaticMarkup(<OpsErrorState description="运营 API 暂时不可用" />);
    expect(markup).toContain('aria-label="重试"');
    expect(markup).toContain("重试");
  });

  it("preserves real children only in the ready state", () => {
    const markup = renderToStaticMarkup(<OpsDataState state="ready"><table aria-label="审计记录"><tbody /></table></OpsDataState>);
    expect(markup).toContain('data-state="ready"');
    expect(markup).toContain('aria-label="审计记录"');
  });
});
