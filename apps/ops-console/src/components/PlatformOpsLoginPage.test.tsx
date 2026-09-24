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
    expect(markup).not.toContain("连接诊断");
  });

});
