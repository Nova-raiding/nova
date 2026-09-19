import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OpsSession } from "../../types/ops.js";
import { ControlledSessionBar, jitExpiryReached } from "./ControlledSessionBar.js";
import { nextJitExpiryAt } from "../../authz/jitGrant.js";

const session: OpsSession = {
  actor_id: "actor_1",
  workspace_id: "ws_1",
  roles: ["platform_ops"],
  canonical_roles: ["ops_admin"],
  workspace_granted: true,
  capabilities: ["platform.summary.read"],
  scopes: [{ type: "platform", ids: ["*"] }],
  workbench: "platform",
};

const liveGrant = {
  id: "grant_1",
  access_mode: "read" as const,
  workspace_id: "ws_1",
  resource_scope: { type: "workspace", ids: ["ws_1"] },
  expires_at: "2999-01-01T00:00:00.000Z",
  max_uses: 3,
  use_count: 1,
};

describe("nextJitExpiryAt", () => {
  it("picks the earliest finite grant deadline", () => {
    expect(nextJitExpiryAt([
      { expires_at: "2999-01-02T00:00:00.000Z" },
      { expires_at: "2999-01-01T00:00:00.000Z" },
    ])).toBe(Date.parse("2999-01-01T00:00:00.000Z"));
  });

  it("ignores session-bounded grants without a parseable deadline", () => {
    expect(nextJitExpiryAt([{ expires_at: "not-a-date" }, {}])).toBeUndefined();
    expect(nextJitExpiryAt([])).toBeUndefined();
    expect(nextJitExpiryAt(undefined)).toBeUndefined();
  });
});

describe("jitExpiryReached", () => {
  it("fires only once the server-projected deadline has passed", () => {
    const deadline = Date.parse("2026-09-02T10:00:00.000Z");
    expect(jitExpiryReached(deadline, deadline - 1)).toBe(false);
    expect(jitExpiryReached(deadline, deadline)).toBe(true);
    expect(jitExpiryReached(undefined, deadline)).toBe(false);
  });
});

describe("ControlledSessionBar", () => {
  it("keeps the controlled session scope, remaining time and exit reachable", () => {
    const html = renderToStaticMarkup(
      <ControlledSessionBar
        session={{ ...session, temporary_grants: [liveGrant] }}
        onExpired={() => undefined}
        onExit={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="受控会话"');
    expect(html).toContain("受控会话 · 只读");
    expect(html).toContain("范围 workspace:ws_1");
    expect(html).toContain("已使用 1/3 次");
    expect(html).toContain("退出受控会话");
    expect(html).toContain('aria-label="退出受控会话并清除本机已加载的授权数据"');
    // The per-second countdown must not be announced, only the absolute expiry.
    expect(html).toContain("到期时间 2999-01-01T00:00:00.000Z");
    expect(html).toMatch(/aria-hidden="true"[^<]*剩余 \d+:\d\d/u);
  });

  it("renders nothing when the projection carries no live grant", () => {
    expect(renderToStaticMarkup(<ControlledSessionBar session={session} onExpired={() => undefined} />)).toBe("");
    expect(renderToStaticMarkup(
      <ControlledSessionBar
        session={{ ...session, temporary_grants: [{ ...liveGrant, expires_at: "2000-01-01T00:00:00.000Z" }] }}
        onExpired={() => undefined}
      />,
    )).toBe("");
    expect(renderToStaticMarkup(<ControlledSessionBar />)).toBe("");
  });

  it("wires the header callbacks into the bar so the expiry cleanup is reachable", () => {
    const header = readFileSync(new URL("../OpsHeader.tsx", import.meta.url), "utf8");
    const controller = readFileSync(new URL("../../pages/OpsConsoleController.tsx", import.meta.url), "utf8");

    expect(header).toContain("<ControlledSessionBar session={session} onExpired={onJitExpired} onExit={onJitExit} />");
    // The controller must give those two props a real cleanup: drop the stale
    // revocation receipt, drop every authorization-scoped dataset, reload.
    expect(controller).toContain("onJitExpired={() => { model.clearJitRevocationReceipt(); model.clearAuthorizationScopedData(); void model.load(); }}");
    expect(controller).toContain("onJitExit={() => { model.clearJitRevocationReceipt(); model.clearAuthorizationScopedData(); void model.load(); }}");
  });
});
