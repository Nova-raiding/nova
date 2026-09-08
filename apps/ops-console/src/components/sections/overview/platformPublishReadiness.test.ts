import { describe, expect, it } from "vitest";
import {
  canPublishToProduction,
  platformAuthorizationPresentation,
  platformMediaPresentation,
  platformReadPresentation,
} from "./PlatformReadinessSection";
import type { PlatformOperation } from "../../../types/ops";

const readyRow: PlatformOperation = {
  platform: "taobao",
  state: "connected",
  readEnabled: true,
  writeEnabled: true,
  capabilities: [{ capability: "catalog_read", state: "production_canary" }],
  readiness: { ready: true, mediaUpload: { ready: true, configured: true, evidence: true } },
};

describe("production publish readiness", () => {
  it("requires every release gate instead of treating connector readiness as publish readiness", () => {
    expect(canPublishToProduction(readyRow)).toBe(true);
    expect(canPublishToProduction({ ...readyRow, capabilities: [{ capability: "catalog_read", state: "fixture_verified" }] })).toBe(false);
    expect(canPublishToProduction({ ...readyRow, writeEnabled: false })).toBe(false);
    expect(canPublishToProduction({ ...readyRow, state: "fixture_ready" })).toBe(false);
    expect(canPublishToProduction({ ...readyRow, dataMode: "fixture" })).toBe(false);
    expect(canPublishToProduction({ ...readyRow, simulated: true })).toBe(false);
  });

  it("never renders fixture read or media capability as green completion", () => {
    const fixtureRow = { ...readyRow, accountCount: 3, dataMode: "fixture", simulated: true };
    expect(platformAuthorizationPresentation(fixtureRow)).toEqual({ color: "gold", label: "3 个演示店铺" });
    expect(platformReadPresentation(fixtureRow)).toEqual({ color: "gold", label: "演示读取" });
    expect(platformMediaPresentation(fixtureRow)).toEqual({ color: "gold", label: "未验证（fixture）" });
    expect(platformReadPresentation(readyRow)).toEqual({ color: "green", label: "已开启" });
    expect(platformMediaPresentation(readyRow)).toEqual({ color: "green", label: "可上传" });
  });

  it("keeps mixed real-account authorization out of the green state", () => {
    expect(platformAuthorizationPresentation({
      ...readyRow,
      state: "partially_connected",
      accountCount: 3,
      connectedAccountCount: 2,
    })).toEqual({ color: "orange", label: "2/3 个店铺已连接" });
  });
});
