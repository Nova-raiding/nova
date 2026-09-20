import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { useOpsConsoleModel, type OpsConsoleModel } from "./useOpsConsoleModel";

// The hook reads the stored workbench selection during render; there is no DOM
// in this environment, so the test supplies the same surface a browser would.
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
};

/** Instantiate the real model without running its effects (SSR never does). */
function renderUnloadedModel(): OpsConsoleModel {
  let captured: OpsConsoleModel | undefined;
  function Probe() {
    captured = useOpsConsoleModel();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (!captured) throw new Error("the ops console model did not render");
  return captured;
}

describe("ops console model read state", () => {
  // Regression: these datasets were seeded with `[]`, which the governance
  // section renders as a measured zero. A pending or failed read then looked
  // exactly like "the workspace has no rules, assets, competitors or
  // suggestions" — a green all-clear over requests that never landed.
  it("starts every knowledge dataset as not read, not as read empty", () => {
    const model = renderUnloadedModel();

    expect(model.knowledgeRules).toBeUndefined();
    expect(model.knowledgeAssets).toBeUndefined();
    expect(model.learningSuggestions).toBeUndefined();
    expect(model.competitors).toBeUndefined();
  });

  it("starts the marketing queue unread while keeping the queue shape panels render", () => {
    const model = renderUnloadedModel();

    expect(model.marketingQueueLoadedAt).toBeUndefined();
    expect(model.marketingQueue.generation).toEqual([]);
    expect(model.marketingQueue.uploadedAssetRisks).toEqual([]);
  });
});
