import { Button, Result, Space, Typography } from "antd";
import { useEffect, useRef } from "react";
import type { OpsScope } from "../../authz/authorization.js";

export function AccessDeniedResult({
  domainLabel,
  capability,
  scope,
  requestId,
  traceId,
  reasonCode,
  onBack,
  onRefresh,
}: {
  domainLabel: string;
  capability: string;
  scope: OpsScope;
  requestId?: string;
  traceId?: string;
  reasonCode?: string;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);
  const scopeText = scope.kind === "platform" ? "平台全局" : `${scope.kind}:${scope.id ?? "未识别"}`;
  return (
    <Result
      status="403"
      title={<span ref={headingRef} tabIndex={-1} role="heading" aria-level={1}>无权访问“{domainLabel}”</span>}
      subTitle="当前会话不具备此运营域的读取能力；服务端仍会独立校验每个请求。"
      extra={<Space><Button type="primary" onClick={onBack}>返回运营总览</Button><Button onClick={onRefresh}>刷新权限</Button></Space>}
    >
      <div className="access-denied-evidence" role="alert" aria-live="assertive" aria-labelledby="access-denied-evidence-title">
        <Typography.Title level={5} id="access-denied-evidence-title" className="sr-only">权限拒绝详情</Typography.Title>
        <Typography.Paragraph>缺失能力：<Typography.Text code>{capability}</Typography.Text></Typography.Paragraph>
        <Typography.Paragraph>当前范围：<Typography.Text code>{scopeText}</Typography.Text></Typography.Paragraph>
        {requestId ? <Typography.Paragraph>请求 ID：<Typography.Text copyable code>{requestId}</Typography.Text></Typography.Paragraph> : null}
        {traceId ? <Typography.Paragraph>追踪 ID：<Typography.Text copyable code>{traceId}</Typography.Text></Typography.Paragraph> : null}
        {reasonCode ? <Typography.Paragraph>决策原因：<Typography.Text code>{reasonCode}</Typography.Text></Typography.Paragraph> : null}
      </div>
    </Result>
  );
}
