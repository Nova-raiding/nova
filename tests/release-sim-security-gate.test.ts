import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const composeArgs = [
  "compose",
  "-p",
  "release-sim-security-test",
  "-f",
  "infra/local/docker-compose.yml",
  "-f",
  "infra/local/docker-compose.release-sim.yml",
  "config",
  "--format",
  "json",
];

const required = {
  RELEASE_SIM_SESSION_ID_HASH_SECRET:
    "test-session-secret-with-sufficient-entropy",
  RELEASE_SIM_OIDC_SIGNING_SECRET: "test-oidc-secret-with-sufficient-entropy",
  RELEASE_SIM_WORKER_SYNC_API_TOKEN: "test-sync-token-with-sufficient-entropy",
  RELEASE_SIM_WORKER_SYNC_SIGNING_SECRET: "test-sync-signing-with-sufficient-entropy",
  RELEASE_SIM_WORKER_GENERATION_API_TOKEN: "test-generation-token-with-sufficient-entropy",
  RELEASE_SIM_WORKER_GENERATION_SIGNING_SECRET: "test-generation-signing-with-sufficient-entropy",
  RELEASE_SIM_WORKER_PUBLISH_API_TOKEN: "test-publish-token-with-sufficient-entropy",
  RELEASE_SIM_WORKER_PUBLISH_SIGNING_SECRET: "test-publish-signing-with-sufficient-entropy",
  RELEASE_SIM_WORKER_RECONCILE_API_TOKEN: "test-reconcile-token-with-sufficient-entropy",
  RELEASE_SIM_WORKER_RECONCILE_SIGNING_SECRET: "test-reconcile-signing-with-sufficient-entropy",
  RELEASE_SIM_WORKER_AUTOMATION_API_TOKEN: "test-automation-token-with-sufficient-entropy",
  RELEASE_SIM_WORKER_AUTOMATION_SIGNING_SECRET: "test-automation-signing-with-sufficient-entropy",
  RELEASE_SIM_MERCHANT_API_TOKEN:
    "test-merchant-token-with-sufficient-entropy",
  RELEASE_SIM_RELEASE_ID: "release-sim-security-test",
  RELEASE_SIM_RELEASE_GIT_SHA: "a".repeat(40),
  RELEASE_SIM_RELEASE_MANIFEST_SHA256: "b".repeat(64),
  RELEASE_SIM_RELEASE_IMAGE_SET_DIGEST: `sha256:${"c".repeat(64)}`,
};

type Service = {
  environment?: Record<string, string>;
  healthcheck?: { test?: string[] };
  ports?: Array<{ host_ip?: string; published?: string; target?: number }>;
};

type ComposeConfig = { services: Record<string, Service> };

function render(
  env: NodeJS.ProcessEnv = { ...process.env, ...required },
): ComposeConfig {
  return JSON.parse(
    execFileSync("docker", composeArgs, {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  ) as ComposeConfig;
}

describe("release-sim security boundary", () => {
  it.each(Object.keys(required))(
    "fails closed when %s is absent",
    (variable) => {
      const env: NodeJS.ProcessEnv = { ...process.env, ...required };
      delete env[variable];
      expect(() => render(env)).toThrow(new RegExp(`${variable} is required`));
    },
    30_000,
  );

  it("keeps both API replicas on the same production-safe configuration", () => {
    const services = render().services;
    const api = services.api?.environment;
    const replica = services["api-replica"]?.environment;
    const invariantKeys = [
      "LOCAL_COMPOSE",
      "CONNECTOR_FIXTURE_MODE",
      "ALLOW_LOCAL_DURABLE_OBJECT_STORAGE",
      "ALLOW_LOCAL_PAYMENT_FIXTURE",
      "RUN_MIGRATIONS_ON_STARTUP",
      "DB_POOL_MAX",
      "OPS_DB_POOL_MAX",
      "ALLOW_WILDCARD_WORKSPACE_GRANT",
      "API_AUTH_TOKENS",
      "OPS_AUTH_MODE",
      "MERCHANT_BEARER_HOSTNAME",
      "SESSION_ID_HASH_SECRET",
      "OIDC_PROXY_SIGNING_SECRET",
      "WORKER_API_CREDENTIALS",
      "RELEASE_ID",
      "RELEASE_GIT_SHA",
      "RELEASE_MANIFEST_SHA256",
      "RELEASE_IMAGE_SET_DIGEST",
    ];

    expect(api).toBeDefined();
    expect(replica).toBeDefined();
    for (const key of invariantKeys) expect(replica?.[key]).toBe(api?.[key]);
    expect(api).toMatchObject({
      LOCAL_COMPOSE: "false",
      CONNECTOR_FIXTURE_MODE: "false",
      ALLOW_LOCAL_DURABLE_OBJECT_STORAGE: "false",
      ALLOW_LOCAL_PAYMENT_FIXTURE: "false",
      RUN_MIGRATIONS_ON_STARTUP: "false",
      DB_POOL_MAX: "10",
      OPS_DB_POOL_MAX: "3",
      ALLOW_WILDCARD_WORKSPACE_GRANT: "false",
      OPS_AUTH_MODE: "oidc",
      MERCHANT_BEARER_HOSTNAME: "127.0.0.1",
    });
    const grants = JSON.parse(api?.API_AUTH_TOKENS ?? "{}") as Record<string, unknown>;
    expect(grants).toEqual({
      [required.RELEASE_SIM_MERCHANT_API_TOKEN]: {
        workspaces: ["ws_demo"],
        actor_id: "support_demo",
        roles: ["support"],
      },
    });
    expect(services.ui?.environment?.MERCHANT_API_TOKEN).toBe(
      required.RELEASE_SIM_MERCHANT_API_TOKEN,
    );
    const credentials = JSON.parse(api?.WORKER_API_CREDENTIALS ?? "{}") as Record<string, { token: string; signing_secret: string }>;
    expect(Object.keys(credentials).sort()).toEqual(["automation", "generation", "publish", "reconcile", "sync"]);
    expect(new Set(Object.values(credentials).map(value => value.token)).size).toBe(5);
    expect(new Set(Object.values(credentials).map(value => value.signing_secret)).size).toBe(5);
    for (const role of Object.keys(credentials)) {
      const worker = services[`worker-${role}`]?.environment;
      expect(worker?.WORKER_API_TOKEN).toBe(credentials[role]?.token);
      expect(worker?.WORKER_API_SIGNING_SECRET).toBe(credentials[role]?.signing_secret);
    }
  });

  it("makes Merchant UI readiness prove the API upstream and production probe contract", () => {
    const services = render().services;
    expect(services.ui?.healthcheck?.test?.join(" ")).toContain(
      "127.0.0.1:8080/readyz",
    );
    const nginx = readFileSync("infra/nginx/merchant-studio.conf", "utf8");
    expect(nginx).toContain("location = /readyz");
    expect(nginx).toContain("proxy_pass http://$merchant_api_host:8787/readyz");
    const deployment = readFileSync("infra/kubernetes/base/ui.yaml", "utf8");
    expect(deployment).toContain("readinessProbe: {httpGet: {path: /readyz, port: http}");
  });

  it("publishes browser and API ports on loopback only and keeps data services private", () => {
    const services = render().services;
    for (const name of ["api", "api-replica", "ui", "ops-ui"]) {
      expect(services[name]?.ports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ host_ip: "127.0.0.1" }),
        ]),
      );
    }
    expect(services.postgres?.ports ?? []).toEqual([]);
    expect(services.redis?.ports ?? []).toEqual([]);
  });
});
