import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OpsHeader } from "./OpsHeader.js";

describe("OpsHeader account authentication UX", () => {
  it("shows account/password login for an unauthenticated operator", () => {
    const markup = renderToStaticMarkup(
      <OpsHeader managedSession={false} sessionLoaded={false} onRefresh={() => undefined} />,
    );
    expect(markup).toContain("平台运营账号登录");
    expect(markup).toContain("账号信息");
    expect(markup).toContain("未登录");
  });

  it("documents server-side session and password handling", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("./OpsHeader.tsx", import.meta.url), "utf8"),
    );
    expect(source).toContain("HttpOnly 会话");
    expect(source).toContain("密码不会保存到浏览器");
  });

  it("renders authenticated logout state and account identity wiring", async () => {
    const markup = renderToStaticMarkup(
      <OpsHeader
        managedSession={false}
        sessionLoaded
        session={{
          actor_id: "ops@example.com",
          workspace_id: "",
          roles: ["platform_ops"],
          workbench: "platform",
          workspace_granted: false,
          scope: { type: "platform" },
        }}
        onRefresh={() => undefined}
      />,
    );
    expect(markup).toContain("ops@example.com");
    expect(markup).toContain("打开账号信息");
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("./OpsHeader.tsx", import.meta.url), "utf8"),
    );
    expect(source).toContain("session?.actor_id");
    expect(source).toContain("当前账号");
    expect(source).toContain("退出登录");
  });

  it("keeps account identity and workbench label on one horizontal row", async () => {
    const styles = await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../styles.css", import.meta.url), "utf8"),
    );
    expect(styles).toMatch(/\.ops-account-trigger-copy\s*\{[^}]*display:\s*flex/s);
    expect(styles).toMatch(/\.ops-account-trigger\s*\{[^}]*width:\s*280px/s);
  });
});
