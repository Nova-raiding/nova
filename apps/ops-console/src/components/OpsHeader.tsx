import { useEffect, useId, useRef, useState } from "react";
import { Alert, Button, Drawer, Input, Layout, Space, Tag, Typography, type InputRef } from "antd";
import { describeOpsError, hasOpsConnection, hasOpsCredentials, readOpsConnectionConfig, saveOpsConnectionConfig, type OpsConnectionConfigInput } from "../api/opsClient.js";
import type { OpsDataSource } from "../types/ops.js";
import type { OpsSession } from "../types/ops.js";
import type { OpsWorkbench } from "../types/ops.js";
import { createAuthorizationProjection, type AuthorizationProjection } from "../authz/authorization.js";
import { RoleScopeBar } from "./authz/RoleScopeBar.js";

interface OpsHeaderProps {
  managedSession: boolean;
  roles?: string[];
  sessionLoaded: boolean;
  onRefresh: () => void;
  dataSource?: OpsDataSource;
  refreshing?: boolean;
  session?: OpsSession;
  authorization?: AuthorizationProjection;
  activeWorkbench?: OpsWorkbench;
  availableWorkbenches?: readonly OpsWorkbench[];
  switchingWorkbench?: boolean;
  onWorkbenchChange?: (workbench: OpsWorkbench) => void;
  onJitExpired?: () => void;
  onJitExit?: () => void;
}

export function saveAndRefreshOpsConnection(config: OpsConnectionConfigInput, onRefresh: () => void) {
  const existing = readOpsConnectionConfig();
  const saved = saveOpsConnectionConfig({
    ...config,
    token: config.token?.trim() || existing.token,
  });
  onRefresh();
  return saved;
}

export function readOpsConnectionDraft(): OpsConnectionConfigInput {
  const config = readOpsConnectionConfig();
  return { ...config, token: "" };
}

export function OpsConfigError({ message }: { message?: string }) {
  return message ? <span id="ops-workspace-id-error" role="alert" aria-live="assertive" className="ops-config-error">{message}</span> : null;
}

export function workspaceFieldAccessibility(message?: string) {
  return message
    ? { "aria-invalid": true as const, "aria-describedby": "ops-workspace-id-error" }
    : { "aria-invalid": undefined, "aria-describedby": undefined };
}

type ConnectionRecoveryField = "apiBase" | "workspaceId" | "token";

export function connectionRecoveryField(config: OpsConnectionConfigInput, managedSession: boolean): ConnectionRecoveryField {
  if (!config.apiBase.trim()) return "apiBase";
  if (!config.workspaceId.trim()) return "workspaceId";
  if (!managedSession && !(config.token ?? "").trim()) return "token";
  return "apiBase";
}

export function connectionRecoveryLabel(field: ConnectionRecoveryField): string {
  switch (field) {
    case "workspaceId":
      return "工作区 ID";
    case "token":
      return "运营 API Token";
    default:
      return "运营 API 地址";
  }
}

export function OpsHeader({
  managedSession,
  roles,
  sessionLoaded,
  onRefresh,
  dataSource,
  refreshing = false,
  session,
  authorization,
  activeWorkbench,
  availableWorkbenches,
  switchingWorkbench,
  onWorkbenchChange,
  onJitExpired,
  onJitExit,
}: OpsHeaderProps) {
  const resolvedAuthorization = authorization ?? createAuthorizationProjection(session, managedSession);
  const [draft, setDraft] = useState<OpsConnectionConfigInput>(readOpsConnectionDraft);
  const [configError, setConfigError] = useState<string>();
  const [workspaceIdError, setWorkspaceIdError] = useState<string>();
  const apiBaseRef = useRef<InputRef>(null);
  const workspaceIdRef = useRef<InputRef>(null);
  const tokenRef = useRef<InputRef>(null);
  const configErrorRef = useRef<HTMLDivElement>(null);
  const connectionToggleRef = useRef<HTMLButtonElement>(null);
  const connectionTitleId = useId();
  const connectionDescriptionId = useId();
  // Managed/OIDC production sessions lead with identity and scope. Connection
  // details remain available on demand for diagnosis, but never dominate the
  // desktop workbench first paint.
  const [connectionOpen, setConnectionOpen] = useState(false);
  const connectionState = !hasOpsCredentials()
    ? "missing-credentials"
    : !hasOpsConnection()
      ? "missing-workspace"
      : sessionLoaded
        ? "ready"
        : "loading";

  useEffect(() => {
    if (!configError) return undefined;
    const focusTimer = window.requestAnimationFrame(() => configErrorRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(focusTimer);
  }, [configError]);

  const recoveryField = workspaceIdError ? "workspaceId" : connectionRecoveryField(draft, managedSession);
  const recoveryLabel = connectionRecoveryLabel(recoveryField);

  function focusConnectionField(field: ConnectionRecoveryField) {
    const target = field === "workspaceId"
      ? workspaceIdRef
      : field === "token"
        ? tokenRef
        : apiBaseRef;
    target.current?.focus({ preventScroll: true });
  }

  function resetDraftToSavedConfig() {
    const restored = readOpsConnectionDraft();
    setDraft(restored);
    setConfigError(undefined);
    setWorkspaceIdError(undefined);
    if (typeof window === "undefined") return;
    const nextField = connectionRecoveryField(restored, managedSession);
    window.requestAnimationFrame(() => focusConnectionField(nextField));
  }

  useEffect(() => {
    if (!connectionOpen || configError || typeof window === "undefined") return undefined;
    const focusTimer = window.requestAnimationFrame(() => focusConnectionField(connectionRecoveryField(draft, managedSession)));
    return () => window.cancelAnimationFrame(focusTimer);
  }, [configError, connectionOpen, draft, managedSession]);

  return (
    <Layout.Header className="ops-header">
      <div>
        <Typography.Text className="eyebrow">
          WORKSPACE OPERATIONS
        </Typography.Text>
        <Typography.Title level={2}>商业与平台控制台</Typography.Title>
        <RoleScopeBar session={session} authorization={resolvedAuthorization} activeWorkbench={activeWorkbench} availableWorkbenches={availableWorkbenches} switching={switchingWorkbench} onWorkbenchChange={onWorkbenchChange} onJitExpired={onJitExpired} onJitExit={onJitExit} />
      </div>
      <div className="ops-connection-toolbar">
        <div className="ops-connection-summary">
          <span className="ops-connection-summary-label">连接状态</span>
          <Tag role="status" aria-live="polite" aria-busy={refreshing || undefined} data-state={connectionState} className="ops-status-tag" color={!hasOpsConnection() ? "orange" : managedSession && !sessionLoaded ? "orange" : "blue"}>
            {refreshing ? "正在刷新" : !hasOpsCredentials() ? "待配置" : !hasOpsConnection() ? "待填写工作区" : sessionLoaded ? "已连接" : "读取中"}
          </Tag>
        </div>
        <Button
          ref={connectionToggleRef}
          type="default"
          className="ops-connection-toggle"
          aria-expanded={connectionOpen}
          aria-controls="ops-connection-fields"
          onClick={() => setConnectionOpen(open => !open)}
        >
          {connectionOpen ? "收起连接诊断" : "连接诊断"}
        </Button>
      </div>
      <Drawer
        title={<span id={connectionTitleId}>连接诊断</span>}
        aria-labelledby={connectionTitleId}
        aria-describedby={connectionDescriptionId}
        // AntD's portal cannot mount during SSR. Keep the disclosure state on
        // the button, but only mount the Drawer body in a browser so server
        // rendering stays warning-free and hydration does not touch secrets.
        open={typeof window !== "undefined" && connectionOpen}
        onClose={() => setConnectionOpen(false)}
        size="small"
        getContainer={false}
        destroyOnHidden={false}
        afterOpenChange={(open) => {
          if (open || typeof window === "undefined") return;
          window.requestAnimationFrame(() => connectionToggleRef.current?.focus({ preventScroll: true }));
        }}
        className="ops-connection-drawer"
        styles={{ body: { paddingTop: 16 } }}
      >
      <form
        id="ops-connection-fields"
        className="ops-connection-form"
        aria-label="运营 API 连接配置"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            saveAndRefreshOpsConnection(draft, onRefresh);
            setConfigError(undefined);
            setWorkspaceIdError(undefined);
            setConnectionOpen(false);
          } catch (cause) {
            const message = describeOpsError(cause);
            setConfigError(message);
            setWorkspaceIdError(!draft.workspaceId.trim() ? message : undefined);
          }
        }}
      >
      <p id={connectionDescriptionId} className="sr-only">修改本机运营 API 连接配置后保存并刷新。连接失败时请修正字段并重试。</p>
      <Space orientation="vertical" size="middle" className="full-width">
        {configError ? (
          <div ref={configErrorRef} tabIndex={-1} aria-label="连接配置错误" className="ops-config-error-summary">
            <Alert
              type="error"
              showIcon
              title="连接配置未保存"
              description={<><OpsConfigError message={configError} /><span>当前草稿已保留，请先修正字段，再保存并刷新。</span></>}
              action={<Button htmlType="button" size="small" style={{ minHeight: 44 }} aria-label={`定位到${recoveryLabel}`} onClick={() => focusConnectionField(recoveryField)}>定位到{recoveryLabel}</Button>}
            />
          </div>
        ) : null}
        <label className="ops-connection-field">
          <span>运营 API 地址</span>
          <Input
            ref={apiBaseRef}
            name="apiBase"
            value={draft.apiBase}
            onChange={(event) => {
              setDraft(current => ({ ...current, apiBase: event.target.value }));
              setConfigError(undefined);
            }}
            placeholder="真实运营 API 地址"
          />
        </label>
        <label className="ops-connection-field">
          <span>工作区 ID</span>
          <Input
            ref={workspaceIdRef}
            name="workspaceId"
            value={draft.workspaceId}
            onChange={(event) => {
              setDraft(current => ({ ...current, workspaceId: event.target.value }));
              setConfigError(undefined);
              setWorkspaceIdError(undefined);
            }}
            placeholder="工作区 ID"
            status={workspaceIdError ? "error" : undefined}
            {...workspaceFieldAccessibility(workspaceIdError)}
          />
        </label>
        {managedSession ? (
          <Tag color="green" className="ops-status-tag">SSO 托管会话</Tag>
        ) : (
          <>
            <Alert
              type="warning"
              showIcon
              title="本地开发适配器"
              description="仅用于本机 Docker 验证；不会代表生产 OIDC 身份，也不能作为生产上线证据。"
            />
            <label className="ops-connection-field">
              <span>操作员 ID</span>
              <Input
                name="actorId"
                autoComplete="username"
                value={draft.actorId ?? ""}
                onChange={(event) => setDraft(current => ({ ...current, actorId: event.target.value }))}
                placeholder="操作员 ID"
              />
            </label>
            <label className="ops-connection-field">
              <span>运营 API Token</span>
              <Input.Password
                ref={tokenRef}
                name="token"
                autoComplete="current-password"
                value={draft.token ?? ""}
                placeholder={hasOpsCredentials() ? "已配置；留空保持不变" : "Bearer token（仅存本机）"}
                onChange={(event) => {
                  setDraft(current => ({ ...current, token: event.target.value }));
                  setConfigError(undefined);
                }}
              />
            </label>
          </>
        )}
        <Tag role="status" aria-live="polite" data-state={connectionState} className="ops-status-tag" color={!hasOpsConnection() ? "orange" : managedSession && !sessionLoaded ? "orange" : "blue"}>
          {!hasOpsCredentials()
            ? "请配置真实 API Token"
            : !hasOpsConnection()
              ? "请配置真实工作区 ID"
            : sessionLoaded
            ? `角色：${roles?.join("、") || "未声明"}`
            : managedSession
              ? "正在读取角色"
              : "正在读取真实数据"}
        </Tag>
        {dataSource ? (
          <Tag role="status" data-state={dataSource.fixtureDataPresent ? "warning" : dataSource.persistence === "postgres" ? "ready" : "unverified"} className="ops-status-tag" color={dataSource.fixtureDataPresent ? "orange" : dataSource.persistence === "postgres" ? "green" : "gold"}>
            {dataSource.fixtureDataPresent
              ? `Postgres/API · 含演示数据（真实店铺 ${dataSource.officialStoreCount ?? 0}，演示店铺 ${dataSource.fixtureStoreCount ?? 0}）`
              : dataSource.persistence === "postgres"
                ? "真实 Postgres/API 数据"
                : `非生产数据：${dataSource.persistence ?? "未识别"}`}
          </Tag>
        ) : null}
        <div role="group" aria-label="连接诊断操作" style={{ display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <Button htmlType="button" style={{ minHeight: 44 }} onClick={() => setConnectionOpen(false)}>关闭</Button>
          <Space wrap>
            <Button htmlType="button" style={{ minHeight: 44 }} disabled={refreshing} onClick={resetDraftToSavedConfig}>恢复已保存配置</Button>
            <Button className="ops-refresh-button" htmlType="submit" style={{ minHeight: 44 }} loading={refreshing} disabled={refreshing} aria-busy={refreshing} aria-label="刷新数据（保存连接配置）">{refreshing ? "正在刷新" : "保存并刷新"}</Button>
          </Space>
        </div>
      </Space>
      </form>
      </Drawer>
    </Layout.Header>
  );
}
