import { describe, expect, it } from "vitest";
import { modelChannelRows } from "./ModelChannelMatrix.js";
import type { ModelStatus } from "../../types/ops.js";

describe("model channel matrix", () => {
  it("keeps provider configuration, cost evidence and final readiness separate", () => {
    const status = {
      ownership: "platform",
      user_key_binding: false,
      state: "partial_model_readiness",
      provider_host: "relay.example.test",
      capabilities: { text_generation: true, image_generation: false },
      model_readiness: {
        text: { ready: true, provider_configured: true },
        image: { ready: false, provider_configured: true, reasons: ["SVIP 计费组未启用"] },
      },
      cost_evidence_by_modality: { text: true, image: false },
      text_model: "qianwen-text",
      image_model: "image-model",
      quotas: { rpm: 100, tpm: 1000, daily_cny_limit: "100.00" },
      next_actions: [],
    } satisfies ModelStatus;

    expect(modelChannelRows(status).slice(0, 2)).toEqual([
      expect.objectContaining({ key: "text", providerConfigured: true, costEvidence: true, ready: true }),
      expect.objectContaining({ key: "image", providerConfigured: true, costEvidence: false, ready: false, reasons: ["SVIP 计费组未启用"] }),
    ]);
  });

  it("never treats a missing status as ready", () => {
    expect(modelChannelRows(undefined).every((row) => !row.ready && !row.costEvidence)).toBe(true);
  });
});
