import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StoreDirectorySection, storeAuthorizationStateLabel } from "./StoreDirectorySection.js";

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
  it("keeps internal authorization enums out of the operator-facing label", () => {
    expect(storeAuthorizationStateLabel("unknown")).toBe("状态待确认");
    expect(storeAuthorizationStateLabel("connected")).toBe("真实授权");
    expect(storeAuthorizationStateLabel("unexpected_state")).toBe("状态待确认");
  });

  it("labels a credential-free manual store record as unauthorized, never as connected", () => {
    const label = storeAuthorizationStateLabel("manually_registered");

    expect(label).toBe("人工登记（未授权）");
    // 真实授权 is taken by `connected`; the manual record writes no credential,
    // scope or platform receipt and must not be mistaken for it.
    expect(label).not.toBe("真实授权");
    expect(label).not.toBe(storeAuthorizationStateLabel("connected"));
    expect(label).not.toBe("状态待确认");
  });

  it("keeps refresh_required out of the unknown bucket", () => {
    expect(storeAuthorizationStateLabel("refresh_required")).toBe("需重新授权");
    expect(storeAuthorizationStateLabel("refresh_required")).not.toBe("状态待确认");
  });

  it("renders a manually registered store as unauthorized instead of all clear", () => {
    const markup = render({
      storeDirectory: [{ ...store, state: "manually_registered", dataMode: "account_record_only", readable: false }],
    });

    expect(markup).toContain("人工登记（未授权）");
    expect(markup).not.toContain("真实授权");
  });

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
    expect(markup).not.toContain("暂无已登记店铺");
    expect(markup).not.toContain("尚未连接店铺不代表没有工作区权限");
    expect(markup).toContain("检查网络或工作区权限");
  });

  it("distinguishes a missing store connection from workspace permission in the empty state", () => {
    const markup = render({ storeDirectory: [] });

    expect(markup).toContain("暂无已登记店铺");
    expect(markup).toContain("尚未连接店铺不代表没有工作区权限");
    expect(markup).toContain("可先在已授权工作区导入商品资料、预览草稿");
    expect(markup).toContain("真实平台同步和发布仍需连接对应店铺，并具备相应操作权限");
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain("店铺目录读取失败");
  });

  it("does not announce an empty directory before loading succeeds", () => {
    const markup = render({ storeDirectory: [], loading: true });

    expect(markup).toContain("正在读取店铺目录");
    expect(markup).not.toContain("暂无已登记店铺");
    expect(markup).not.toContain("尚未连接店铺不代表没有工作区权限");
  });
});
