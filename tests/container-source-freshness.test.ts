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

const script = "infra/scripts/verify-container-source-freshness.sh";
const apiDigest = `sha256:${"a".repeat(64)}`;
const workerDigest = `sha256:${"b".repeat(64)}`;
const apiContainerId = "c".repeat(64);
const workerContainerId = "d".repeat(64);
const apiRef = `registry.example.com/merchant-api@${apiDigest}`;
const workerRef = `registry.example.com/merchant-worker@${workerDigest}`;
const temporaryDirectories: string[] = [];

type Fixture = {
  root: string;
  workspace: string;
  api: string;
  worker: string;
  source: string;
  apiSourceMeta: string;
  workerSourceMeta: string;
  bin: string;
  env: Record<string, string>;
};

function migration(directory: string, filename: string, contents: string) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, filename), contents);
}

function sourceFile(root: string, path: string, contents: string) {
  const destination = join(root, path);
  mkdirSync(join(destination, ".."), { recursive: true });
  writeFileSync(destination, contents);
}

function generateSourceMetadataPair(
  source: string,
  apiOutput: string,
  workerOutput: string,
) {
  mkdirSync(apiOutput, { recursive: true });
  mkdirSync(workerOutput, { recursive: true });
  const shared = [
    "package-lock.json",
    "package.json",
    "packages/shared/src/index.ts",
    "tsconfig.json",
  ];
  const profiles = {
    api: ["apps/api/src/server.ts", "apps/plugin/mcp/bridge.mjs", ...shared],
    worker: ["apps/worker/src/main.ts", ...shared],
  } as const;
  for (const [profile, paths] of Object.entries(profiles)) {
    const manifest = `${[...paths]
      .sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)),
      )
      .map(
        (path) =>
          `${createHash("sha256")
            .update(readFileSync(join(source, path)))
            .digest("hex")}  ${path}`,
      )
      .join("\n")}\n`;
    const output = profile === "api" ? apiOutput : workerOutput;
    writeFileSync(join(output, `${profile}.manifest`), manifest);
    writeFileSync(
      join(output, `${profile}.manifest.sha256`),
      `sha256:${createHash("sha256").update(manifest).digest("hex")}\n`,
    );
  }
}

function rewriteManifest(
  output: string,
  profile: "api" | "worker",
  lines: string[],
) {
  const manifest = `${lines.sort((left, right) => Buffer.compare(Buffer.from(left.slice(66)), Buffer.from(right.slice(66)))).join("\n")}\n`;
  writeFileSync(join(output, `${profile}.manifest`), manifest);
  writeFileSync(
    join(output, `${profile}.manifest.sha256`),
    `sha256:${createHash("sha256").update(manifest).digest("hex")}\n`,
  );
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "container-source-freshness-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  const api = join(root, "api");
  const worker = join(root, "worker");
  const source = join(root, "source");
  const apiSourceMeta = join(root, "api-source-meta");
  const workerSourceMeta = join(root, "worker-source-meta");
  const bin = join(root, "bin");
  for (const directory of [
    workspace,
    api,
    worker,
    source,
    apiSourceMeta,
    workerSourceMeta,
    bin,
  ])
    mkdirSync(directory, { recursive: true });
  for (const directory of [workspace, api, worker]) {
    migration(directory, "063_previous.sql", "SELECT 63;\n");
    migration(directory, "064_current.sql", "SELECT 64;\n");
  }
  sourceFile(source, "apps/api/src/server.ts", "export const api = true\n");
  sourceFile(
    source,
    "apps/plugin/mcp/bridge.mjs",
    "export const plugin = true\n",
  );
  sourceFile(source, "apps/worker/src/main.ts", "export const worker = true\n");
  sourceFile(
    source,
    "packages/shared/src/index.ts",
    "export const shared = true\n",
  );
  sourceFile(source, "package.json", '{"private":true}\n');
  sourceFile(source, "package-lock.json", '{"lockfileVersion":3}\n');
  sourceFile(source, "tsconfig.json", '{"compilerOptions":{}}\n');
  generateSourceMetadataPair(source, apiSourceMeta, workerSourceMeta);
  const fakeDocker = join(bin, "docker");
  writeFileSync(
    fakeDocker,
    `#!/bin/sh
set -eu
command_name=\${1:-}
shift || true
case "$command_name" in
  image)
    [ "\${1:-}" = inspect ] || exit 91
    shift
    [ "\${1:-}" = --format ] || exit 92
    shift 2
    case "\${1:-}" in
      *merchant-api*) printf '%s\\n' '${apiDigest}' ;;
      *merchant-worker*) printf '%s\\n' '${workerDigest}' ;;
      *) exit 93 ;;
    esac
    ;;
  create)
    case "\${1:-}" in
      '${apiDigest}') printf '%s\\n' '${apiContainerId}' ;;
      '${workerDigest}') printf '%s\\n' '${workerContainerId}' ;;
      *) exit 94 ;;
    esac
    ;;
  cp)
    source_spec=\${1:-}
    destination=\${2:-}
    case "$source_spec" in
      ${apiContainerId}:*/.release-source/api.manifest) cp "\${FAKE_API_SOURCE_DIR:?}/api.manifest" "$destination"; exit 0 ;;
      ${apiContainerId}:*/.release-source/api.manifest.sha256) cp "\${FAKE_API_SOURCE_DIR:?}/api.manifest.sha256" "$destination"; exit 0 ;;
      ${workerContainerId}:*/.release-source/worker.manifest) cp "\${FAKE_WORKER_SOURCE_DIR:?}/worker.manifest" "$destination"; exit 0 ;;
      ${workerContainerId}:*/.release-source/worker.manifest.sha256) cp "\${FAKE_WORKER_SOURCE_DIR:?}/worker.manifest.sha256" "$destination"; exit 0 ;;
      ${apiContainerId}:*) source_dir=\${FAKE_API_MIGRATIONS_DIR:?} ;;
      ${workerContainerId}:*)
        [ "\${FAKE_WORKER_COPY_FAIL:-false}" != true ] || exit 95
        source_dir=\${FAKE_WORKER_MIGRATIONS_DIR:?}
        ;;
      *) exit 96 ;;
    esac
    cp -R "$source_dir/." "$destination/"
    ;;
  container)
    [ "\${1:-}" = rm ] || exit 97
    ;;
  *) exit 98 ;;
esac
`,
    { mode: 0o700 },
  );
  chmodSync(fakeDocker, 0o700);
  return {
    root,
    workspace,
    api,
    worker,
    source,
    apiSourceMeta,
    workerSourceMeta,
    bin,
    env: {
      ...process.env,
      NODE_ENV: "test",
      CONTAINER_FRESHNESS_TEST_HOOK: "enabled-for-tests-only",
      CONTAINER_FRESHNESS_TEST_MIGRATIONS_DIR: workspace,
      CONTAINER_FRESHNESS_TEST_SOURCE_ROOT: source,
      CONTAINER_FRESHNESS_TEST_IMAGE_MIGRATIONS_PATH: "/fixture/migrations",
      FAKE_API_MIGRATIONS_DIR: api,
      FAKE_WORKER_MIGRATIONS_DIR: worker,
      FAKE_API_SOURCE_DIR: apiSourceMeta,
      FAKE_WORKER_SOURCE_DIR: workerSourceMeta,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    },
  };
}

function run(
  item: Fixture,
  args = [apiRef, workerRef, apiDigest, workerDigest],
  env: Record<string, string> = {},
) {
  return execFileSync("sh", [script, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...item.env, ...env },
    stdio: "pipe",
  });
}

afterEach(() => {
  while (temporaryDirectories.length > 0)
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe("container source freshness gate", () => {
  it("reads both immutable images without running them and matches the latest migration SHA-256", () => {
    const item = fixture();
    const output = run(item);
    expect(output).toContain("API image freshness passed");
    expect(output).toContain("Worker image freshness passed");
    expect(output).toContain("migration=064_current.sql");
  }, 15_000);

  it("rejects mutable tags before asking Docker to inspect an image", () => {
    const item = fixture();
    expect(() =>
      run(item, ["merchant-api:latest", workerRef, apiDigest, workerDigest]),
    ).toThrow(/tags are forbidden/);
  });

  it("fails closed when Docker is unavailable", () => {
    const item = fixture();
    expect(() => run(item, undefined, { PATH: "/usr/bin:/bin" })).toThrow(
      /docker CLI is required/,
    );
  });

  it("fails when the workspace migration directory or image assets are missing", () => {
    const item = fixture();
    expect(() =>
      run(item, undefined, {
        CONTAINER_FRESHNESS_TEST_MIGRATIONS_DIR: join(item.root, "missing"),
      }),
    ).toThrow(/migrations directory is missing/);
    expect(() =>
      run(item, undefined, { FAKE_WORKER_COPY_FAIL: "true" }),
    ).toThrow(/Worker image is missing migration assets/);
  });

  it("rejects duplicate migration versions in either the workspace or an image", () => {
    const workspaceDuplicate = fixture();
    migration(
      workspaceDuplicate.workspace,
      "064_duplicate.sql",
      "SELECT 640;\n",
    );
    expect(() => run(workspaceDuplicate)).toThrow(
      /workspace contains duplicate migration version 064/,
    );

    const imageDuplicate = fixture();
    migration(imageDuplicate.api, "064_duplicate.sql", "SELECT 640;\n");
    expect(() => run(imageDuplicate)).toThrow(
      /API image contains duplicate migration version 064/,
    );
  });

  it("rejects an image whose highest migration is stale", () => {
    const stale = fixture();
    rmSync(join(stale.worker, "064_current.sql"));
    expect(() => run(stale)).toThrow(
      /Worker image latest migration is 063 but workspace latest is 064/,
    );
  }, 15_000);

  it("rejects an image whose highest migration has different bytes", () => {
    const mismatched = fixture();
    writeFileSync(join(mismatched.worker, "064_current.sql"), "SELECT 6400;\n");
    expect(() => run(mismatched)).toThrow(
      /Worker image migration SHA-256 differs/,
    );
  });

  it("rejects API source changes even when migrations still match", () => {
    const apiChanged = fixture();
    sourceFile(
      apiChanged.source,
      "apps/api/src/server.ts",
      'export const api = "changed"\n',
    );
    expect(() => run(apiChanged)).toThrow(
      /API image source manifest has missing, extra, or content-mismatched build inputs/,
    );
  });

  it("rejects Worker source changes even when migrations still match", () => {
    const workerChanged = fixture();
    sourceFile(
      workerChanged.source,
      "apps/worker/src/main.ts",
      'export const worker = "changed"\n',
    );
    expect(() => run(workerChanged)).toThrow(
      /Worker image source manifest has missing, extra, or content-mismatched build inputs/,
    );
  });

  it("rejects shared-package source changes even when migrations still match", () => {
    const packageChanged = fixture();
    sourceFile(
      packageChanged.source,
      "packages/shared/src/index.ts",
      'export const shared = "changed"\n',
    );
    expect(() => run(packageChanged)).toThrow(
      /API image source manifest has missing, extra, or content-mismatched build inputs/,
    );
  });

  it("fails closed for a missing image manifest", () => {
    const missing = fixture();
    expect(() =>
      run(missing, undefined, {
        FAKE_API_SOURCE_DIR: join(missing.root, "missing"),
      }),
    ).toThrow(/API image is missing its fixed source manifest/);
  });

  it("fails closed for an internally tampered image manifest", () => {
    const tampered = fixture();
    writeFileSync(
      join(tampered.apiSourceMeta, "api.manifest"),
      "not a manifest\n",
    );
    expect(() => run(tampered)).toThrow(
      /API image source manifest is malformed or internally inconsistent/,
    );
  }, 15_000);

  it("fails closed for an image manifest with a missing entry", () => {
    const missingEntry = fixture();
    const originalLines = readFileSync(
      join(missingEntry.apiSourceMeta, "api.manifest"),
      "utf8",
    )
      .trimEnd()
      .split("\n");
    rewriteManifest(missingEntry.apiSourceMeta, "api", originalLines.slice(1));
    expect(() => run(missingEntry)).toThrow(
      /API image source manifest has missing, extra, or content-mismatched build inputs/,
    );
  });

  it("fails closed for an image manifest with an extra entry", () => {
    const extraEntry = fixture();
    const extraLines = readFileSync(
      join(extraEntry.workerSourceMeta, "worker.manifest"),
      "utf8",
    )
      .trimEnd()
      .split("\n");
    extraLines.push(`${"e".repeat(64)}  packages/shared/src/unexpected.ts`);
    rewriteManifest(extraEntry.workerSourceMeta, "worker", extraLines);
    expect(() => run(extraEntry)).toThrow(
      /Worker image source manifest has missing, extra, or content-mismatched build inputs/,
    );
  });

  it("rejects path anomalies even when an attacker recomputes the total digest", () => {
    const item = fixture();
    const lines = readFileSync(join(item.apiSourceMeta, "api.manifest"), "utf8")
      .trimEnd()
      .split("\n");
    lines.push(`${"f".repeat(64)}  ../server.ts`);
    rewriteManifest(item.apiSourceMeta, "api", lines);
    expect(() => run(item)).toThrow(
      /API image source manifest is malformed or internally inconsistent/,
    );
  });

  it("keeps test-only path overrides fail-closed outside the exact test hook", () => {
    const item = fixture();
    expect(() => run(item, undefined, { NODE_ENV: "production" })).toThrow(
      /test hook is forbidden/,
    );
    expect(() =>
      run(item, undefined, { CONTAINER_FRESHNESS_TEST_HOOK: "" }),
    ).toThrow(/test hook is forbidden/);
  });

  it("is wired into deploy preflight for API and Worker and documents the separate UI coverage boundary", () => {
    const preflight = readFileSync("infra/scripts/deploy-preflight.sh", "utf8");
    expect(preflight).toContain("verify-container-source-freshness.sh");
    expect(preflight).toContain("API_IMAGE_REF");
    expect(preflight).toContain("WORKER_IMAGE_REF");
    const apiDockerfile = readFileSync("infra/docker/api.Dockerfile", "utf8");
    const workerDockerfile = readFileSync(
      "infra/docker/worker.Dockerfile",
      "utf8",
    );
    expect(apiDockerfile).toContain(
      "COPY packages/persistence/src/migrations ./dist/packages/persistence/src/migrations",
    );
    expect(workerDockerfile).toContain(
      "COPY packages/persistence/src/migrations ./dist/packages/persistence/src/migrations",
    );
    for (const dockerfile of [apiDockerfile, workerDockerfile]) {
      expect(dockerfile).toContain("/app/.release-source/api.manifest");
      expect(dockerfile).toContain("/app/.release-source/worker.manifest");
      expect(dockerfile).toContain("id=merchant-npm-cache");
      expect(dockerfile.indexOf("generate api")).toBeLessThan(
        dockerfile.indexOf("npm ci --prefer-offline"),
      );
      expect(dockerfile.indexOf("generate worker")).toBeLessThan(
        dockerfile.indexOf("npm ci --prefer-offline"),
      );
    }
    const runbook = readFileSync("doc/todo/release/production-ops-runbook.md", "utf8");
    expect(runbook).toContain('API_IMAGE_REF="$API_IMAGE_REF"');
    expect(runbook).toContain('WORKER_IMAGE_REF="$WORKER_IMAGE_REF"');
    expect(runbook).toContain(
      "字节级 source freshness 门禁当前只覆盖 API 与 Worker",
    );
    expect(runbook).toContain(
      "UI/Ops UI 的 immutable digest 绑定与基础镜像固定测试不等价于 source freshness",
    );
  });
});
