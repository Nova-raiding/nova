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

const scopeText = (scope: OpsScope) => scope.kind === "platform" ? "平台全局" : `${scope.kind}:${scope.id ?? "未识别"}`;

/**
 * The permission self-view behind the 403 screen's "查看我的权限" disclosure.
 *
 * It is deliberately a disclosure and not a navigation: in the platform
 * console every surface that lists authorization is itself capability-gated,
 * so a denied operator cannot be sent anywhere that answers the question. The
 * operator's effective grant set is already in the session projection, so it
 * can be answered in place — and the console still offers no self-service
 * elevation, which is stated instead of implied.
 */
export function PermissionSelfView({
  capability,
  scope,
  grantedCapabilities,
}: {
  capability: string;
  scope: OpsScope;
  grantedCapabilities?: readonly string[];
}) {
  const granted = normalizeDiagnosticTokens(grantedCapabilities);
  return (
    <div id="access-denied-permissions" className="access-denied-permissions-content">
      <Typography.Paragraph>
        当前身份范围：<Typography.Text code>{scopeText(scope)}</Typography.Text>
      </Typography.Paragraph>
      <Typography.Paragraph>
        你当前已获得的能力（服务端投影，未返回的能力不会显示为空权限）：
      </Typography.Paragraph>
      {granted?.length ? (
        <ul className="access-denied-capability-list">
          {granted.map((item) => <li key={item}><Typography.Text code>{item}</Typography.Text></li>)}
        </ul>
      ) : (
        <Typography.Paragraph type="secondary">当前会话没有被授予任何运营能力。</Typography.Paragraph>
      )}
      <Typography.Paragraph type="secondary">
        缺失能力 <Typography.Text code>{capability}</Typography.Text> 只能由服务端授权策略下发：平台运营控制台
        消费服务端投影，不会在本控制台自助申请或自助提权。请联系平台管理员调整角色或签发临时授权后，
        再使用“刷新权限”重新获取授权投影。
      </Typography.Paragraph>
    </div>
  );
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
  grantedCapabilities,
  onBack,
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
  grantedCapabilities?: readonly string[];
  onBack: () => void;
  onRefresh: () => void;
  refreshing?: boolean;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);
  const resolvedScopeText = scopeText(scope);
  const visibleObligations = normalizeDiagnosticTokens(obligationsMissing);
  const accessContext = `当前会话在${resolvedScopeText}范围内缺少 ${capability} 能力；服务端仍会独立校验每个请求。`;
  return (
    <Result
      status="403"
      title={<h1 ref={headingRef} tabIndex={-1} className="ops-result-heading">无权访问“{domainLabel}”</h1>}
      subTitle={<span id="access-denied-context">{accessContext}{requestId ? ` 请求 ID：${requestId}。` : ""}</span>}
      extra={<Space className="access-denied-actions" aria-busy={refreshing || undefined}>
        <Button type="primary" onClick={onBack}>返回用户中心</Button>
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
        <Typography.Paragraph>当前范围：<Typography.Text code>{resolvedScopeText}</Typography.Text></Typography.Paragraph>
        {requestId ? <Typography.Paragraph>请求 ID：<Typography.Text copyable code>{requestId}</Typography.Text></Typography.Paragraph> : null}
        {traceId ? <Typography.Paragraph>追踪 ID：<Typography.Text copyable code>{traceId}</Typography.Text></Typography.Paragraph> : null}
        {decisionId ? <Typography.Paragraph>决策 ID：<Typography.Text copyable code>{decisionId}</Typography.Text></Typography.Paragraph> : null}
        {reasonCode ? <Typography.Paragraph>决策原因：{explainAccessDeniedReason(reasonCode)} <Typography.Text code>{reasonCode}</Typography.Text></Typography.Paragraph> : null}
        {visibleObligations?.length ? <Typography.Paragraph>缺失义务：<Typography.Text code>{visibleObligations.join(", ")}</Typography.Text></Typography.Paragraph> : null}
      </div>
      {/* A native disclosure, not a navigation: it cannot become a silent
          no-op, it is keyboard operable without extra wiring, and its content
          is present in the markup for a static render to assert. */}
      <details className="access-denied-permissions">
        <summary className="access-denied-permissions-trigger">查看我的权限</summary>
        <PermissionSelfView capability={capability} scope={scope} grantedCapabilities={grantedCapabilities} />
      </details>
    </Result>
  );
}
