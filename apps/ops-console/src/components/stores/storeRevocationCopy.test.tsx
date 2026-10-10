import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StoreDirectorySection } from "./StoreDirectorySection.js";
import { storeRevocationCopy } from "./storeRevocationCopy.js";

const callbacks = {
  canManageStoreConnections: true,
  onSaveAlias: vi.fn(async () => true),
  onRevoke: vi.fn(async () => undefined),
};

describe("store revocation copy", () => {
  it("describes manual account records as revoking the registration, not a platform grant", () => {
    const manualStore = {
      platform: "taobao" as const,
      accountId: "manual-store-1",
      label: "人工登记店",
      state: "manually_registered" as const,
      dataMode: "account_record_only" as const,
      readable: false,
      writeEnabled: false,
      revision: 1,
    };
    const copy = storeRevocationCopy(manualStore);
    const markup = renderToStaticMarkup(<StoreDirectorySection {...callbacks} storeDirectory={[manualStore]} />);

    expect(copy).toMatchObject({
      actionLabel: "撤销登记",
      dialogTitle: "确认撤销人工登记？",
      confirmLabel: "确认撤销登记",
      successMessage: "人工店铺登记已撤销",
    });
    expect(copy.description).toContain("不会向平台发送撤销请求");
    expect(markup).toContain("撤销登记");
    expect(markup).not.toContain("确认撤销平台授权？");
  });

  it("keeps the existing platform authorization wording for a connected store", () => {
    const connectedStore = {
      platform: "taobao" as const,
      accountId: "connected-store-1",
      label: "已授权店",
      state: "connected" as const,
      dataMode: "official_api" as const,
      readable: true,
      writeEnabled: false,
      revision: 2,
    };
    const copy = storeRevocationCopy(connectedStore);
    const markup = renderToStaticMarkup(<StoreDirectorySection {...callbacks} storeDirectory={[connectedStore]} />);

    expect(copy).toMatchObject({
      actionLabel: "撤销",
      dialogTitle: "确认撤销平台授权？",
      confirmLabel: "确认撤销",
      successMessage: "店铺授权已撤销",
    });
    expect(markup).toContain("<span>撤销</span>");
  });

  it("does not infer a manual registration from account-record-only data mode after revocation", () => {
    const revokedPlatformStore = {
      platform: "taobao" as const,
      accountId: "revoked-platform-store-1",
      label: "已撤销的平台店",
      state: "revoked",
      dataMode: "account_record_only",
      readable: false,
      writeEnabled: false,
      revision: 3,
    };
    const copy = storeRevocationCopy(revokedPlatformStore);
    const markup = renderToStaticMarkup(<StoreDirectorySection {...callbacks} storeDirectory={[revokedPlatformStore]} />);

    expect(copy.actionLabel).toBe("已撤销");
    expect(copy.description).toContain("授权已撤销");
    expect(copy.description).not.toContain("人工登记");
    expect(markup).toContain("已撤销");
    expect(markup).not.toContain("撤销登记");
  });
});
