import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlatformOpsLoginPage } from "./PlatformOpsLoginPage.js";

describe("PlatformOpsLoginPage", () => {
  it("renders a complete account/password login form instead of a connection diagnostic", () => {
    const markup = renderToStaticMarkup(
      <PlatformOpsLoginPage managedSession={false} onAuthenticated={() => undefined} onRetry={() => undefined} />,
    );
    expect(markup).toContain("登录平台运营后台");
    expect(markup).toContain('id="ops-login-account"');
    expect(markup).toContain('id="ops-login-password"');
    expect(markup).toContain("平台管理员分配的运营账号");
    expect(markup).not.toMatch(/\bplaceholder=/u);
    expect(markup).not.toContain("连接诊断");
    expect(markup).not.toContain('class="ops-login-alert"');
  });

  it("shows a warning only when an actual session error is provided", () => {
    const markup = renderToStaticMarkup(
      <PlatformOpsLoginPage managedSession={false} error="登录状态已失效，请重新登录" onAuthenticated={() => undefined} onRetry={() => undefined} />,
    );
    expect(markup).toContain("ops-login-alert");
    expect(markup).toContain("登录状态已失效，请重新登录");
  });

});
