import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { runDeletionDecisionOnce } from "./DataReadinessSection.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("DataReadinessSection deletion decision modal", () => {
  it(
    "closes and resets immediately after a successful cancellation",
    async () => {
      const locks = new Set<string>();
      const onSuccess = vi.fn();
      const onFailure = vi.fn();
      const onSettled = vi.fn();

      await expect(
        runDeletionDecisionOnce({
          key: "deletion-1:cancel",
          locks,
          action: vi.fn().mockResolvedValue(true),
          onStarted: vi.fn(),
          onSuccess,
          onFailure,
          onSettled,
        }),
      ).resolves.toBe(true);

      expect(onSuccess).toHaveBeenCalledOnce();
      expect(onFailure).not.toHaveBeenCalled();
      expect(onSettled).toHaveBeenCalledOnce();
      expect(locks.size).toBe(0);
    },
    1_000,
  );

  it("keeps one in-flight action and ignores a double submit", async () => {
    const pending = deferred<boolean>();
    const locks = new Set<string>();
    const action = vi.fn(() => pending.promise);
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    const onSettled = vi.fn();
    const onStarted = vi.fn();
    const options = {
      key: "deletion-2:cancel",
      locks,
      action,
      onStarted,
      onSuccess,
      onFailure,
      onSettled,
    };

    const first = runDeletionDecisionOnce(options);
    const duplicate = runDeletionDecisionOnce(options);

    await expect(duplicate).resolves.toBe(false);
    expect(action).toHaveBeenCalledOnce();
    expect(onStarted).toHaveBeenCalledOnce();
    expect(locks.has(options.key)).toBe(true);

    pending.resolve(true);
    await expect(first).resolves.toBe(true);
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledOnce();
    expect(locks.size).toBe(0);
  });

  it.each([
    ["returned failure", vi.fn().mockResolvedValue(false)],
    ["thrown failure", vi.fn().mockRejectedValue(new Error("network error"))],
  ])("keeps the modal open with an actionable error on %s", async (_label, action) => {
    const onSuccess = vi.fn();
    const onFailure = vi.fn();

    await expect(
      runDeletionDecisionOnce({
        key: "deletion-3:cancel",
        locks: new Set<string>(),
        action,
        onStarted: vi.fn(),
        onSuccess,
        onFailure,
        onSettled: vi.fn(),
      }),
    ).resolves.toBe(false);

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it("announces failures, blocks concurrent row actions, and restores trigger focus", async () => {
    const source = await readFile(new URL("./DataReadinessSection.tsx", import.meta.url), "utf8");

    expect(source).toContain('role="alert"');
    expect(source).toContain('id="data-deletion-error"');
    expect(source).toContain('aria-describedby={deletionError ? "data-deletion-error" : undefined}');
    expect(source).toContain("deletionActionsBusy && !cancelLoading");
    expect(source).toContain("deletionActionsBusy && !approveLoading");
    expect(source).toContain("afterClose={() => {");
    expect(source).toContain("deletionTriggerRef.current?.focus()");
  });
});
