import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("keeps unread conflict queues unknown and rejects a previous workspace's late response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ops-conflict-browser-evidence-"));
  try {
    const script = fileURLToPath(new URL("../../../scripts/verify-canonical-conflict-scope.mjs", import.meta.url));
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [script], {
        env: { ...process.env, CONFLICT_ARTIFACTS: directory }, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", data => { output += String(data); });
      child.stderr.on("data", data => { output += String(data); });
      child.on("error", reject);
      child.on("close", code => resolve({ code, output }));
    });
    expect(result.code, result.output).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
