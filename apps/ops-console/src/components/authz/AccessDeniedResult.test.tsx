import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccessDeniedResult, explainAccessDeniedReason } from "./AccessDeniedResult.js";

describe("access denied result", () => {
  it("explains server authorization decisions and uses a safe fallback", () => {
    expect(explainAccessDeniedReason("AUTHZ_JIT_EXPIRED")).toContain("临时授权已过期");
    expect(explainAccessDeniedReason("unknown_reason")).toContain("服务端权限策略拒绝");
  });

  it("renders scope, evidence IDs, bounded obligations, and the no-self-elevation message", () => {
    const html = renderToStaticMarkup(<AccessDeniedResult
      domainLabel="知识库"
      capability="knowledge.read"
      scope={{ kind: "workspace", id: "ws-1" }}
      requestId="req-1"
      traceId="trace-1"
      reasonCode="AUTHZ_CAPABILITY_MISSING"
      obligationsMissing={["read", "read"]}
      grantedCapabilities={["ops.read"]}
      onBack={() => undefined}
      onRefresh={() => undefined}
    />);
    expect(html).toContain("知识库");
    expect(html).toContain("workspace:ws-1");
    expect(html).toContain("req-1");
    expect(html).toContain("read");
    expect(html).toContain("不会在本控制台自助申请或自助提权");
  });
});
