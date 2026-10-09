import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ModelStatus } from "../../types/ops.js";
import { ModelChannelMatrix } from "./ModelChannelMatrix.js";
import { ModelReadinessTable } from "./ModelReadinessTable.js";

const configuredStatus = {
  ownership: "platform",
  user_key_binding: false,
  state: "ready",
  provider_host: "relay.example",
  image_provider_host: "relay.example",
  text_model: "text-v1",
  image_model: "image-v1",
  image_edit_model: "image-edit-v1",
  vision_model: "ocr-v1",
  video_model: "video-v1",
  relay: { configured: true, host: "relay.example", reasons: [] },
  capabilities: {
    text_generation: true,
    image_generation: true,
    image_editing: true,
    image_fact_ocr: true,
    video_rendering: true,
    knowledge_vector_indexing: false,
  },
  model_readiness: Object.fromEntries(["text", "image", "image_edit", "ocr", "video"].map(key => [key, {
    ready: true, https: true, reasons: [], provider_configured: true,
  }])),
  quotas: { rpm: 10, tpm: 1000, daily_cny_limit: "10.00" },
  task_cost_limit: { ready: true, maximum_task_cost_cny: "2.00", reasons: [] },
  cost_control_ready: true,
  cost_evidence_ready: true,
  cost_evidence_by_modality: { text: true, image: true, image_edit: true, ocr: true, video: true },
  release_metadata_ready: true,
  release_metadata_missing: [],
  next_actions: [],
} as unknown as ModelStatus;

describe("model readiness wording", () => {
  it.each([
    ["readiness table", createElement(ModelReadinessTable, { status: configuredStatus })],
    ["channel matrix", createElement(ModelChannelMatrix, { status: configuredStatus })],
  ])("does not present configured status as successful generation in the %s", (_name, element) => {
    const markup = renderToStaticMarkup(element);

    expect(markup).toContain("配置与额度门禁");
    expect(markup).toContain("真实生成尚未验证");
    expect(markup).toContain("未执行真实生成 canary");
    expect(markup).not.toContain("运行态 ready");
    expect(markup).not.toContain(">可用<");
  });
});
