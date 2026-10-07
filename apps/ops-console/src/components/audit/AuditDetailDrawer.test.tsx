import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("antd", () => {
  const passthrough = ({ children, ...props }: any) => createElement("div", props, children);
  const Descriptions = ({ children }: any) => createElement("dl", null, children);
  Descriptions.Item = ({ label, children }: any) => createElement("div", null, createElement("dt", null, label), createElement("dd", null, children));
  const Typography = {
    Text: ({ children }: any) => createElement("span", null, children),
    Title: ({ children }: any) => createElement("h5", null, children),
    Paragraph: ({ children, ...props }: any) => createElement("p", props, children),
  };
  return {
    Alert: ({ title, description, action }: any) => createElement("div", { role: "alert" }, title, description, action),
    Button: ({ children }: any) => createElement("button", null, children),
    Descriptions,
    Drawer: ({ title, children }: any) => createElement("section", null, title, children),
    Empty: ({ description }: any) => createElement("div", null, description),
    Skeleton: () => createElement("div", null, "loading"),
    Tag: ({ children }: any) => createElement("span", null, children),
    Typography,
  };
});

import { AuditDetailDrawer } from "./AuditDetailDrawer.js";

const selected = { id: "audit-1" } as any;
const detail = {
  id: "audit-1",
  source: "operation",
  actorId: "operator-1",
  action: "rule.approve",
  resourceType: "rule",
  resourceId: "rule-1",
  reason: "人工复核",
  occurredAt: "2026-10-07T04:00:00.000Z",
  evidence: { fields: { decision_id: "decision-1", allowed: true, omitted: null }, omittedFields: 3 },
} as any;

const baseProps = { loading: false, onClose: vi.fn() };

describe("AuditDetailDrawer", () => {
  it("keeps the drawer closed without a selected record", () => {
    const html = renderToStaticMarkup(<AuditDetailDrawer {...baseProps} />);
    expect(html).toContain("审计证据详情");
    expect(html).not.toContain("rule.approve");
  });

  it("renders only the server-declared redacted evidence fields", () => {
    const html = renderToStaticMarkup(<AuditDetailDrawer {...baseProps} selected={selected} detail={detail} />);
    expect(html).toContain("服务端已脱敏");
    expect(html).toContain("decision-1");
    expect(html).toContain("3 个敏感、过深或不受支持的字段");
    expect(html).toContain("支付链接和错误元数据不会下发到前端");
  });

  it("exposes a retryable, focusable error state", () => {
    const onRetry = vi.fn();
    const html = renderToStaticMarkup(<AuditDetailDrawer {...baseProps} selected={selected} error="详情服务不可用" onRetry={onRetry} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("详情服务不可用");
    expect(html).toContain("重试");
  });
});
