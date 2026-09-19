import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = join(import.meta.dirname);

function uiSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return uiSources(file);
    if (!/\.tsx?$/u.test(entry.name)) return [];
    // Test files are allowed to name a retired method in order to assert that
    // the UI does not call it; only shipped UI sources are scanned.
    if (/\.test\.tsx?$/u.test(entry.name)) return [];
    return [file];
  });
}

function methodReferences(prefix: string): string[] {
  return uiSources(sourceRoot).flatMap((file) => {
    const hits = readFileSync(file, "utf8")
      .split("\n")
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => line.includes(prefix))
      .map(({ number }) => `${file.slice(sourceRoot.length + 1)}:${number}`);
    return hits;
  });
}

describe("Ops Console control-plane boundary", () => {
  it("keeps the retired feature-flag control plane out of the shipped UI", () => {
    // `scripts/audit-ops-surface.mjs` keeps every `ops.feature-flag*` method in
    // SERVER_ONLY_METHODS: the write and emergency operations require an
    // MFA-backed, approval-aware runbook, so they stay behind the authenticated
    // API/MCP boundary. The former `/ops/feature-flags` route was retired with
    // its page in c7ccc9b7. This guards the leftover panel that used to call
    // those methods from silently re-adding the control plane: a real UI must
    // remove the SERVER_ONLY_METHODS entry in the same change, and delete this
    // test with it.
    expect(methodReferences("ops.feature-flag")).toEqual([]);
  });
});
