import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel.js";
import { modelStateLabel } from "../components/sections/overview/modelReadiness.js";
import { OverviewPage } from "./OverviewPage.js";

const render = (options: { canRead?: boolean; modelError?: string } = {}) => {
  const model = {
    authorization: { can: (capability: string) => capability === "model.status.read" && options.canRead === true },
    workspaceDirectory: { items: [], total: 0, merchantWorkspaceCount: 0, offset: 0, limit: 20, hasMore: false },
    platformFinanceSummary: undefined,
    platformMonthlyFinanceSummary: undefined,
    platformMonthlyFinanceMonth: "2026年10月",
    platformCommercialCatalog: [],
    platformModelUsageSummary: undefined,
    modelStatus: undefined,
    modelStatusLoading: false,
    dataSource: { fixtureDataPresent: false },
    dataSetError: (method: string) => method === "platform.model.status" ? options.modelError : undefined,
    load: async () => undefined,
  } as unknown as OpsConsoleModel;
  return renderToStaticMarkup(<OverviewPage model={model} onNavigate={() => undefined} />);
};

describe("overview model status wiring regression", () => {
  it("translates every API gate state into operator-facing text", () => {
    expect(["ready", "release_metadata_blocked", "model_relay_blocked", "cost_gate_blocked", "partial_model_readiness", "not_configured"].map(modelStateLabel)).toEqual([
      "已就绪", "发布元数据未就绪", "模型中转未就绪", "成本门禁未通过", "部分模型能力未就绪", "模型尚未配置",
    ]);
  });

  it("renders the loaded model diagnostic and fail-closed empty state for authorized readers", () => {
    const html = render({ canRead: true });
    expect(html).toContain("模型服务诊断");
    expect(html).toContain("平台模型状态不可用");
    expect(html).toContain("重试读取平台模型状态");
    expect(html).toContain("这不代表无权限或模型未配置");
    expect(html).not.toContain("当前账号没有模型状态读取权限");
  });

  it("shows a distinct no-permission state and does not render model configuration fields", () => {
    const html = render({ canRead: false });
    expect(html).toContain("当前账号没有模型状态读取权限");
    expect(html).not.toContain("文案模型");
    expect(html).not.toContain("图片模型");
  });

  it("shows a distinct read failure and does not imply the status is configured", () => {
    const html = render({ canRead: true, modelError: "读取失败" });
    expect(html).toContain("平台模型状态读取失败：状态不可用");
    expect(html).toContain("当前状态不能视为配置完成");
    expect(html).toContain("未核实");
    expect(html).not.toContain("平台中转站</span><span>未配置");
  });
});
