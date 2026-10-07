import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const authorization = {
  canAny: vi.fn((capabilities: readonly string[]) => capabilities.includes("allowed")),
  scopeFor: vi.fn((capability: string) => capability === "readonly" ? { kind: "workspace", id: "ws-1" } : undefined),
};

vi.mock("../../authz/AuthorizationProvider.js", () => ({
  useAuthorization: () => authorization,
}));

import { PermissionGate } from "./PermissionGate.js";

describe("PermissionGate", () => {
  it("renders children only when the required capability is granted", () => {
    expect(renderToStaticMarkup(<PermissionGate capability="allowed"><button>操作</button></PermissionGate>)).toContain("操作");
    expect(renderToStaticMarkup(<PermissionGate capability="missing"><button>操作</button></PermissionGate>)).not.toContain("操作");
  });

  it("supports fallback and render-prop state without leaking hidden controls", () => {
    expect(renderToStaticMarkup(<PermissionGate capability="missing" fallback={<span>无权限</span>}><button>操作</button></PermissionGate>)).toContain("无权限");
    expect(renderToStaticMarkup(<PermissionGate capability="missing">{({ allowed, readOnly }) => <span>{String(allowed)}:{String(readOnly)}</span>}</PermissionGate>)).toContain("false:true");
  });

  it("marks denied controls disabled with an accessible reason", () => {
    const html = renderToStaticMarkup(<PermissionGate capability="missing" behavior="disabled" disabledReason="需要管理员授权"><button>操作</button></PermissionGate>);
    expect(html).toContain("disabled");
    expect(html).toContain("需要管理员授权");
    expect(html).toContain("操作暂不可用");
  });

  it("shows the server-projected scope for readonly access", () => {
    const html = renderToStaticMarkup(<PermissionGate capability="readonly" behavior="readonly"><button>操作</button></PermissionGate>);
    expect(html).toContain("当前范围为只读");
    expect(html).toContain("workspace:ws-1");
  });
});
