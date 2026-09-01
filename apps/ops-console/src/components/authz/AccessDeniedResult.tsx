import { Button, Result, Space, Typography } from "antd";
import { useEffect, useRef } from "react";
import type { OpsScope } from "../../authz/authorization.js";

export function explainAccessDeniedReason(reasonCode?: string): string | undefined {
  if (!reasonCode) return undefined;
  const explanations: Record<string, string> = {
    AUTHZ_CAPABILITY_MISSING: "当前会话没有被授予该能力。",
    AUTHZ_SCOPE_MISMATCH: "当前会话的工作区或资源范围与此操作不匹配。",
    AUTHZ_WORKBENCH_MISMATCH: "当前工作台不包含此操作，请切换到服务端指定的工作台。",
    AUTHZ_EXPLICIT_DENY: "权限策略明确拒绝了此操作。",
    AUTHZ_JIT_EXPIRED: "临时授权已过期，请重新申请或联系管理员。",
    AUTHZ_JIT_REVOKED: "临时授权已撤销，请重新申请或联系管理员。",
    AUTHZ_SESSION_UNVERIFIED: "运营权限会话尚未完成服务端验证。",
  };
  return explanations[reasonCode] ?? "服务端权限策略拒绝了此操作。";
}

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
  const accessContext = `当前会话在${scopeText}范围内缺少 ${capability} 能力；服务端仍会独立校验每个请求。`;
  return (
    <Result
      status="403"
      title={<span ref={headingRef} tabIndex={-1} role="heading" aria-level={1}>无权访问“{domainLabel}”</span>}
      subTitle={<span id="access-denied-context">{accessContext}{requestId ? ` 请求 ID：${requestId}。` : ""}</span>}
      extra={<Space className="access-denied-actions"><Button type="primary" onClick={onBack}>返回运营总览</Button><Button onClick={onRefresh}>刷新权限</Button></Space>}
    >
      <div className="access-denied-evidence" role="alert" aria-live="assertive" aria-labelledby="access-denied-evidence-title">
        <Typography.Title level={5} id="access-denied-evidence-title" className="sr-only">权限拒绝详情</Typography.Title>
        <Typography.Paragraph>缺失能力：<Typography.Text code>{capability}</Typography.Text></Typography.Paragraph>
        <Typography.Paragraph>当前范围：<Typography.Text code>{scopeText}</Typography.Text></Typography.Paragraph>
        {requestId ? <Typography.Paragraph>请求 ID：<Typography.Text copyable code>{requestId}</Typography.Text></Typography.Paragraph> : null}
        {traceId ? <Typography.Paragraph>追踪 ID：<Typography.Text copyable code>{traceId}</Typography.Text></Typography.Paragraph> : null}
        {reasonCode ? <Typography.Paragraph>决策原因：{explainAccessDeniedReason(reasonCode)} <Typography.Text code>{reasonCode}</Typography.Text></Typography.Paragraph> : null}
      </div>
    </Result>
  );
}
