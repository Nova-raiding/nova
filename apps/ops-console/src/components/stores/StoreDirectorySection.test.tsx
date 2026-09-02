import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StoreDirectorySection } from "./StoreDirectorySection.js";

const store = {
  platform: "taobao" as const,
  accountId: "store-1",
  label: "淘宝演示店铺",
  state: "connected" as const,
  dataMode: "official_api" as const,
  readable: true,
  writeEnabled: false,
  revision: 1,
};

const render = (overrides: Partial<React.ComponentProps<typeof StoreDirectorySection>> = {}) => renderToStaticMarkup(
  <StoreDirectorySection
    storeDirectory={[store]}
    canPlatformOps
    onRetry={vi.fn()}
    onSaveAlias={vi.fn(async () => true)}
    onRevoke={vi.fn(async () => undefined)}
    {...overrides}
  />,
);

describe("StoreDirectorySection", () => {
  it("keeps the last successful rows visible while a refresh is loading", () => {
    const markup = render({ loading: true });

    expect(markup).toContain("淘宝演示店铺");
    expect(markup).toContain('aria-busy="true"');
  });

  it("announces a stale-data error and exposes a keyboard recovery action", () => {
    const markup = render({ error: "workspace health unavailable" });

    expect(markup).toContain("淘宝演示店铺");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-labelledby="store-directory-error-title"');
    expect(markup).toContain("已保留上一次成功读取的店铺目录");
    expect(markup).toContain("刷新店铺目录");
    expect(markup).toContain('min-height:44px');
  });

  it("does not describe an initial failure as an empty directory", () => {
    const markup = render({ storeDirectory: [], error: "workspace health unavailable" });

    expect(markup).toContain("当前空列表不代表没有已登记店铺");
    expect(markup).not.toContain("暂无已登记店铺；完成平台授权后会显示在这里。");
  });
});
