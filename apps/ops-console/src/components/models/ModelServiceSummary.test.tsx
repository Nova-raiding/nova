import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ModelStatus } from "../../types/ops";
import { ModelServiceSummary } from "./ModelServiceSummary.js";

const blockedStatus: ModelStatus = {
  ownership: "platform",
  user_key_binding: false,
  state: "cost_gate_blocked",
  provider_host: "relay.example.test",
  text_model: "text-model",
  image_model: "image-model",
  vision_model: "vision-model",
  video_model: "video-model",
  relay: { configured: true, host: "relay.example.test" },
  capabilities: {
    text_generation: true,
    image_generation: true,
  },
  model_readiness: {
    text: { provider_configured: true, ready: true },
    image: {
      provider_configured: true,
      ready: false,
      reasons: ["计费组未启用"],
    },
  },
  quotas: { rpm: 100, tpm: 10_000, daily_cny_limit: "500" },
  next_actions: ["启用图片模型计费组"],
};

describe("ModelServiceSummary", () => {
  it("labels model-local ready evidence without claiming global release readiness", () => {
    const html = renderToStaticMarkup(
      <ModelServiceSummary status={{ ...blockedStatus, state: "ready", release_metadata_ready: true }} loading={false} onOpen={vi.fn()} />,
    );
    expect(html).toContain("模型状态接口中的插件构建字段标记");
    expect(html).toContain("/api/releasez");
    expect(html).toContain("不能判定全局发布状态");
    expect(html).toContain("都不代表生产门禁通过");
    expect(html).not.toContain("release metadata 已就绪");
  });

  it("renders a compact readiness summary and the models-page entry", () => {
    const html = renderToStaticMarkup(
      <ModelServiceSummary status={blockedStatus} loading={false} onOpen={vi.fn()} />,
    );

    expect(html).toContain("进入模型服务");
    expect(html).toContain("已就绪能力");
    expect(html).toContain("状态待确认");
    expect(html).not.toContain("cost_gate_blocked");
    expect(html).not.toContain("计费倍率");
  });
});
