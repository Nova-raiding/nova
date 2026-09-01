import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const gate = "infra/scripts/verify-container-source-freshness.sh";
const apiDigest = `sha256:${"a".repeat(64)}`;
const workerDigest = `sha256:${"b".repeat(64)}`;
const apiId = "c".repeat(64);
const workerId = "d".repeat(64);
const temporaryRoots: string[] = [];

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function put(root: string, relative: string, contents: string) {
  const path = join(root, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), "release-sim-worker-freshness-"));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  const apiImage = join(root, "api-image");
  const workerImage = join(root, "worker-image");
  const source = join(root, "source");
  const apiMeta = join(root, "api-meta");
  const workerMeta = join(root, "worker-meta");
  const bin = join(root, "bin");
  for (const path of [workspace, apiImage, workerImage, source, apiMeta, workerMeta, bin])
    mkdirSync(path, { recursive: true });

  for (const directory of [workspace, apiImage, workerImage]) {
    put(directory, "123_previous.sql", "SELECT 123;\n");
    put(directory, "124_current.sql", "SELECT 124;\n");
  }
  for (const [path, contents] of [
    ["apps/api/src/server.ts", "export const api = true;\n"],
    ["apps/plugin/mcp/bridge.mjs", "export const plugin = true;\n"],
    ["apps/worker/src/main.ts", "export const worker = true;\n"],
    ["packages/shared/src/index.ts", "export const shared = true;\n"],
    ["package.json", '{"private":true}\n'],
    ["package-lock.json", '{"lockfileVersion":3}\n'],
    ["tsconfig.json", '{"compilerOptions":{}}\n'],
  ] as const) put(source, path, contents);

  const manifests = {
    api: ["apps/api/src/server.ts", "apps/plugin/mcp/bridge.mjs", "package-lock.json", "package.json", "packages/shared/src/index.ts", "tsconfig.json"],
    worker: ["apps/worker/src/main.ts", "package-lock.json", "package.json", "packages/shared/src/index.ts", "tsconfig.json"],
  } as const;
  for (const [profile, paths] of Object.entries(manifests)) {
    const manifest = `${[...paths].sort().map(path => `${sha256(readFileSync(join(source, path), "utf8"))}  ${path}`).join("\n")}\n`;
    const destination = profile === "api" ? apiMeta : workerMeta;
    writeFileSync(join(destination, `${profile}.manifest`), manifest);
    writeFileSync(join(destination, `${profile}.manifest.sha256`), `sha256:${sha256(manifest)}\n`);
  }

  const docker = join(bin, "docker");
  writeFileSync(docker, `#!/bin/sh
set -eu
case "\${1:-}" in
  image)
    [ "\${2:-}" = inspect ] && [ "\${3:-}" = --format ] || exit 91
    case "\${5:-}" in *merchant-api*) printf '%s\\n' '${apiDigest}' ;; *merchant-worker*) printf '%s\\n' '${workerDigest}' ;; *) exit 92 ;; esac
    ;;
  create)
    case "\${2:-}" in '${apiDigest}') printf '%s\\n' '${apiId}' ;; '${workerDigest}') printf '%s\\n' '${workerId}' ;; *) exit 93 ;; esac
    ;;
  cp)
    case "\${2:-}" in
      ${apiId}:*/.release-source/api.manifest) cp "\${FAKE_API_META}/api.manifest" "\${3}" ;;
      ${apiId}:*/.release-source/api.manifest.sha256) cp "\${FAKE_API_META}/api.manifest.sha256" "\${3}" ;;
      ${workerId}:*/.release-source/worker.manifest) cp "\${FAKE_WORKER_META}/worker.manifest" "\${3}" ;;
      ${workerId}:*/.release-source/worker.manifest.sha256) cp "\${FAKE_WORKER_META}/worker.manifest.sha256" "\${3}" ;;
      ${apiId}:*) cp -R "\${FAKE_API_IMAGE}/." "\${3}/" ;;
      ${workerId}:*) cp -R "\${FAKE_WORKER_IMAGE}/." "\${3}/" ;;
      *) exit 94 ;;
    esac
    ;;
  container) [ "\${2:-}" = rm ] ;;
  *) exit 95 ;;
esac
`, { mode: 0o700 });
  chmodSync(docker, 0o700);
  return {
    root,
    workspace,
    workerImage,
    workerMeta,
    env: {
      ...process.env,
      NODE_ENV: "test",
      CONTAINER_FRESHNESS_TEST_HOOK: "enabled-for-tests-only",
      CONTAINER_FRESHNESS_TEST_MIGRATIONS_DIR: workspace,
      CONTAINER_FRESHNESS_TEST_SOURCE_ROOT: source,
      CONTAINER_FRESHNESS_TEST_IMAGE_MIGRATIONS_PATH: "/fixture/migrations",
      FAKE_API_IMAGE: apiImage,
      FAKE_WORKER_IMAGE: workerImage,
      FAKE_API_META: apiMeta,
      FAKE_WORKER_META: workerMeta,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    },
  };
}

function run(fixture: ReturnType<typeof buildFixture>) {
  return execFileSync("sh", [gate, `registry.example/merchant-api@${apiDigest}`, `registry.example/merchant-worker@${workerDigest}`, apiDigest, workerDigest], {
    cwd: process.cwd(),
    env: fixture.env,
    encoding: "utf8",
    stdio: "pipe",
  });
}

afterEach(() => {
  while (temporaryRoots.length) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

describe("release-sim worker freshness gate", () => {
  it("fails closed when the worker image migration tail is older than the workspace", () => {
    const fixture = buildFixture();
    rmSync(join(fixture.workerImage, "124_current.sql"));
    expect(() => run(fixture)).toThrow(/Worker image latest migration is 123 but workspace latest is 124/);
  }, 15_000);

  it("fails closed when the worker source manifest digest does not match its manifest bytes", () => {
    const fixture = buildFixture();
    writeFileSync(join(fixture.workerMeta, "worker.manifest.sha256"), `sha256:${"f".repeat(64)}\n`);
    expect(() => run(fixture)).toThrow(/Worker image source manifest is malformed or internally inconsistent/);
  }, 15_000);
});
