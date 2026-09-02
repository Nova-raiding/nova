import { Button, Result, Space, Typography } from "antd";
import { useEffect, useRef } from "react";
import type { OpsScope } from "../../authz/authorization.js";
import { normalizeDiagnosticTokens } from "../opsErrorPresentation.js";

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
  decisionId,
  obligationsMissing,
  onBack,
  onViewPermissions,
  onRefresh,
  refreshing = false,
}: {
  domainLabel: string;
  capability: string;
  scope: OpsScope;
  requestId?: string;
  traceId?: string;
  reasonCode?: string;
  decisionId?: string;
  obligationsMissing?: readonly string[];
  onBack: () => void;
  onViewPermissions?: () => void;
  onRefresh: () => void;
  refreshing?: boolean;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);
  const scopeText = scope.kind === "platform" ? "平台全局" : `${scope.kind}:${scope.id ?? "未识别"}`;
  const visibleObligations = normalizeDiagnosticTokens(obligationsMissing);
  const accessContext = `当前会话在${scopeText}范围内缺少 ${capability} 能力；服务端仍会独立校验每个请求。`;
  return (
    <Result
      status="403"
      title={<h1 ref={headingRef} tabIndex={-1} className="ops-result-heading">无权访问“{domainLabel}”</h1>}
      subTitle={<span id="access-denied-context">{accessContext}{requestId ? ` 请求 ID：${requestId}。` : ""}</span>}
      extra={<Space className="access-denied-actions" aria-busy={refreshing || undefined}>
        <Button type="primary" onClick={onBack}>返回运营总览</Button>
        {onViewPermissions ? <Button type="link" onClick={onViewPermissions}>查看我的权限</Button> : null}
        <Button
          onClick={onRefresh}
          loading={refreshing}
          disabled={refreshing}
          aria-busy={refreshing || undefined}
          aria-label={refreshing ? "正在刷新权限" : "刷新权限"}
        >
          {refreshing ? "正在刷新权限" : "刷新权限"}
        </Button>
        {refreshing ? <span className="sr-only" role="status" aria-live="polite">正在刷新权限，请稍候</span> : null}
      </Space>}
    >
      <div className="access-denied-evidence" role="alert" aria-live="assertive" aria-labelledby="access-denied-evidence-title">
        <Typography.Title level={5} id="access-denied-evidence-title" className="sr-only">权限拒绝详情</Typography.Title>
        <Typography.Paragraph>缺失能力：<Typography.Text code>{capability}</Typography.Text></Typography.Paragraph>
        <Typography.Paragraph>当前范围：<Typography.Text code>{scopeText}</Typography.Text></Typography.Paragraph>
        {requestId ? <Typography.Paragraph>请求 ID：<Typography.Text copyable code>{requestId}</Typography.Text></Typography.Paragraph> : null}
        {traceId ? <Typography.Paragraph>追踪 ID：<Typography.Text copyable code>{traceId}</Typography.Text></Typography.Paragraph> : null}
        {decisionId ? <Typography.Paragraph>决策 ID：<Typography.Text copyable code>{decisionId}</Typography.Text></Typography.Paragraph> : null}
        {reasonCode ? <Typography.Paragraph>决策原因：{explainAccessDeniedReason(reasonCode)} <Typography.Text code>{reasonCode}</Typography.Text></Typography.Paragraph> : null}
        {visibleObligations?.length ? <Typography.Paragraph>缺失义务：<Typography.Text code>{visibleObligations.join(", ")}</Typography.Text></Typography.Paragraph> : null}
      </div>
    </Result>
  );
}
