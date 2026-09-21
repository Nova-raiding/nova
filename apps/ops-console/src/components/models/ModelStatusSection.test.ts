import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import { ModelStatusSection } from "./ModelStatusSection";

function render(modelStatusLoading: boolean) {
  return renderToStaticMarkup(
    createElement(ModelStatusSection, {
      model: { modelStatus: undefined, modelStatusLoading, dataSetError: () => undefined, load: async () => undefined } as OpsConsoleModel,
    }),
  );
}

describe("ModelStatusSection", () => {
  const readyStatus = {
    ownership: "platform", user_key_binding: false, state: "ready", provider_host: "relay.example",
    text_model: "text", image_model: "image", vision_model: "ocr", video_model: "video",
    relay: { configured: true, host: "relay.example" },
    capabilities: { text_generation: true, image_generation: true, image_editing: true, image_fact_ocr: true, video_rendering: true },
    model_readiness: {
      text: { ready: true, provider_configured: true, reasons: [] },
      image: { ready: true, provider_configured: true, reasons: [] },
      image_edit: { ready: true, provider_configured: true, reasons: [] },
      ocr: { ready: true, provider_configured: true, reasons: [] },
      video: { ready: true, provider_configured: true, reasons: [] },
    },
    quotas: { rpm: 1, tpm: 1, daily_cny_limit: "1" },
    cost_control_ready: true,
    cost_evidence_ready: true,
    release_metadata_ready: true,
    release_metadata_missing: [],
    next_actions: [],
  };

  it("does not promote model-local ready metadata to global production readiness", () => {
    const markup = renderToStaticMarkup(
      createElement(ModelStatusSection, {
        model: {
          modelStatus: readyStatus,
          modelStatusLoading: false,
          dataSource: { fixtureDataPresent: false },
          dataSetError: () => undefined,
          load: async () => undefined,
        } as unknown as OpsConsoleModel,
      }),
    );
    expect(markup).toContain("五模态运行状态均返回 ready");
    expect(markup).toContain("这不是生产门禁通过");
    expect(markup).toContain("/api/releasez");
    expect(markup).toContain("生产发布身份未核验");
    expect(markup).toContain("该标记不是 /api/releasez 发布身份");
    expect(markup).not.toContain("平台模型配置完整");
    expect(markup).not.toContain("当前模型运行时和发布元数据均已返回就绪");
    expect(markup).not.toContain("最终 readiness");
  });

  it("does not infer success from an empty next-actions list when model state is blocked", () => {
    const markup = renderToStaticMarkup(
      createElement(ModelStatusSection, {
        model: {
          modelStatus: { ...readyStatus, state: "release_metadata_blocked", release_metadata_ready: false },
          modelStatusLoading: false,
          dataSource: { fixtureDataPresent: false },
          dataSetError: () => undefined,
          load: async () => undefined,
        } as unknown as OpsConsoleModel,
      }),
    );
    expect(markup).toContain("模型状态未达到就绪");
    expect(markup).toContain("不得按空建议推断为通过");
    expect(markup).not.toContain("平台模型配置完整");
  });

  it("fails closed instead of showing a previous ready snapshot after refresh failure", () => {
    const markup = renderToStaticMarkup(
      createElement(ModelStatusSection, {
        model: {
          modelStatus: {
            ownership: "platform", user_key_binding: false, state: "ready", provider_host: "relay.example",
            text_model: "text", image_model: "image", vision_model: "ocr", video_model: "video",
            relay: { configured: true, host: "relay.example" },
            capabilities: { text_generation: true, image_generation: true, image_editing: true, image_fact_ocr: true, video_rendering: true },
            model_readiness: {}, quotas: { rpm: 1, tpm: 1, daily_cny_limit: "1" }, next_actions: [],
          },
          modelStatusLoading: false,
          dataSetError: () => "模型状态读取失败",
          load: async () => undefined,
        } as unknown as OpsConsoleModel,
      }),
    );
    expect(markup).toContain(">不可用<");
    expect(markup).not.toContain(">ready<");
    expect(markup).not.toContain("平台模型配置完整");
    expect(markup).toContain("平台模型状态读取失败");
  });

  it("distinguishes unresolved loading from a failed closed unavailable state", () => {
    expect(render(true)).toContain("加载中");
    const unavailable = render(false);
    expect(unavailable).toContain("不可用");
    expect(unavailable).toContain("平台模型状态不可用");
    expect(unavailable).not.toContain(">加载中<");
  });

  it("gives loading state a live status and avoids presenting an empty readiness table", () => {
    const markup = render(true);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain("正在加载平台模型状态");
    expect(markup).not.toContain('模型可用性');
  });

  it("exposes a focusable error summary and keyboard-sized retry action", () => {
    const markup = renderToStaticMarkup(
      createElement(ModelStatusSection, {
        model: {
          modelStatus: undefined,
          modelStatusLoading: false,
          dataSetError: () => "模型状态读取失败",
          load: async () => undefined,
        } as OpsConsoleModel,
      }),
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-live="assertive"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('aria-label="重试加载平台模型状态"');
    expect(markup).toContain("min-height:44px");
    expect(markup).toContain("平台模型状态读取失败");
  });
});
