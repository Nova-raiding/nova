import { useState } from "react";
import { DownOutlined, LogoutOutlined } from "@ant-design/icons";
import { Alert, Button, Dropdown, Empty, Input, Layout, List, Modal, Space, Typography } from "antd";
import { describeOpsError, localOpsSessionEnabled, loginPlatformOps, logoutPlatformOps, suppressLocalOpsSession } from "../api/opsClient.js";
import type { OperationalAlert, OpsDataSource, OpsSession, OpsWorkbench } from "../types/ops.js";
import type { AuthorizationProjection } from "../authz/authorization.js";
import { accountLabel } from "../authz/accountLabel.js";

interface OpsHeaderProps {
  managedSession: boolean;
  roles?: string[];
  sessionLoaded: boolean;
  onRefresh: () => void;
  onSessionReset?: () => void;
  connectionError?: string;
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
  alerts?: readonly OperationalAlert[];
  notifications?: readonly OperationalAlert[];
  onAcknowledgeAlert?: (alert: OperationalAlert) => void;
}

export function OpsHeader({
  managedSession,
  roles,
  sessionLoaded,
  onRefresh,
  onSessionReset,
  connectionError,
  dataSource,
  session,
  authorization,
  activeWorkbench,
  availableWorkbenches,
  switchingWorkbench,
  onWorkbenchChange,
  onJitExpired,
  onJitExit,
  alerts,
  notifications,
  onAcknowledgeAlert,
}: OpsHeaderProps) {
  const [accountOpen, setAccountOpen] = useState(false);
  const [platformLoginOpen, setPlatformLoginOpen] = useState(false);
  const [platformLogin, setPlatformLogin] = useState("");
  const [platformPassword, setPlatformPassword] = useState("");
  const [platformLoginError, setPlatformLoginError] = useState("");
  const [platformLoginPending, setPlatformLoginPending] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);

  const isDemoSession = localOpsSessionEnabled && (
    !session?.session_id || session.actor_id === "actor_demo"
  );
  const hasSession = Boolean(sessionLoaded && session);
  const shouldShowLogin = !hasSession || isDemoSession;
  const merchantNotificationsEnabled = (activeWorkbench ?? session?.workbench) === "workspace" || authorization?.scope.kind !== "platform";
  const allNotifications = merchantNotificationsEnabled ? (notifications ?? alerts ?? []) : [];
  const accountName = hasSession ? accountLabel(session) : (isDemoSession ? "本机演示账号" : "平台运营账号");
  const accountDisplayName = accountName.length > 12 ? `${accountName.slice(0, 8)}…` : accountName;
  const accountInitial = Array.from(accountName)[0] ?? "运";
  const roleLabel = roles?.join("、") || session?.roles?.join("、") || "未声明";

  function openPlatformLogin() {
    setPlatformLoginError("");
    setPlatformLoginOpen(true);
  }

  async function handleLogout() {
    if (logoutPending) return;
    setLogoutPending(true);
    try {
      await logoutPlatformOps();
      suppressLocalOpsSession();
      setAccountOpen(false);
      onSessionReset?.();
      onRefresh();
    } catch (cause) {
      setPlatformLoginError(describeOpsError(cause));
    } finally {
      setLogoutPending(false);
    }
  }

  const accountPanel = (
    <div className="ops-account-popover" role="dialog" aria-label="账号信息">
      <div className="ops-account-popover-header">
        <span className="ops-account-popover-avatar" aria-hidden="true">{accountInitial}</span>
        <div className="ops-account-popover-identity">
          <strong>当前账号：{accountName}</strong>
          <span>{roleLabel}</span>
        </div>
      </div>
      {merchantNotificationsEnabled ? (
        <div className="ops-account-message-center" aria-label="消息中心">
          <div className="ops-account-message-heading">
            <Typography.Text strong>消息中心</Typography.Text>
            <Typography.Text type="secondary">{allNotifications.length ? `${allNotifications.length} 条消息` : "暂无消息"}</Typography.Text>
          </div>
          {allNotifications.length ? (
            <List
              size="small"
              dataSource={allNotifications.slice(0, 8)}
              renderItem={(alert) => (
                <List.Item actions={onAcknowledgeAlert && alert.status === "open" ? [<Button key="ack" type="link" size="small" onClick={() => onAcknowledgeAlert(alert)}>确认</Button>] : undefined}>
                  <List.Item.Meta
                    title={<span className={`ops-notification-severity ${alert.severity}`}>{alert.title}</span>}
                    description={<span>{alert.status === "acknowledged" ? "已读" : "未读"} · {new Date(alert.observedAt).toLocaleString("zh-CN")}</span>}
                  />
                </List.Item>
              )}
            />
          ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无消息" />}
        </div>
      ) : null}
      <div className="ops-account-popover-actions">
        {shouldShowLogin ? <Button type="primary" onClick={openPlatformLogin}>平台运营账号登录</Button> : null}
        {hasSession ? <Button danger icon={<LogoutOutlined />} onClick={() => void handleLogout()} loading={logoutPending}>退出登录</Button> : null}
      </div>
    </div>
  );

  return (
    <Layout.Header className="ops-header">
      <div className="ops-header-actions">
        <div className="ops-connection-toolbar">
          {shouldShowLogin ? (
            <Button type="primary" className="ops-platform-login-trigger" onClick={openPlatformLogin}>
              平台运营账号登录
            </Button>
          ) : null}
          <Dropdown trigger={["click"]} placement="bottomRight" open={accountOpen} onOpenChange={setAccountOpen} popupRender={() => accountPanel}>
            <button type="button" className="ops-account-trigger" aria-label="打开账号信息" aria-haspopup="dialog" aria-expanded={accountOpen}>
              <span className="ops-account-trigger-avatar" aria-hidden="true">{accountInitial}</span>
              <span className="ops-account-trigger-copy">
                <strong title={accountName}>{accountDisplayName}</strong>
              </span>
              <DownOutlined aria-hidden="true" />
            </button>
          </Dropdown>
        </div>
      </div>
      <Modal
        title="平台运营账号登录"
        open={platformLoginOpen}
        okText="登录"
        cancelText="取消"
        confirmLoading={platformLoginPending}
        okButtonProps={{ disabled: !platformLogin.trim() || !platformPassword }}
        onCancel={() => {
          if (!platformLoginPending) {
            setPlatformLoginOpen(false);
            setPlatformLoginError("");
            setPlatformPassword("");
          }
        }}
        onOk={async () => {
          if (!platformLogin.trim() || !platformPassword) return;
          setPlatformLoginPending(true);
          setPlatformLoginError("");
          try {
            await loginPlatformOps({ login: platformLogin, password: platformPassword });
            setPlatformLoginOpen(false);
            setPlatformPassword("");
            onSessionReset?.();
            onRefresh();
          } catch (cause) {
            setPlatformLoginError(describeOpsError(cause));
          } finally {
            setPlatformLoginPending(false);
          }
        }}
      >
        {platformLoginError ? <Alert showIcon type="error" title="登录或退出失败" description={platformLoginError} /> : null}
        <Space orientation="vertical" size="middle" className="full-width">
          <label className="ops-connection-field">
            <span>平台运营账号</span>
            <Input autoComplete="username" value={platformLogin} onChange={(event) => setPlatformLogin(event.target.value)} placeholder="例如 ops@example.com" />
          </label>
          <label className="ops-connection-field">
            <span>密码</span>
            <Input.Password autoComplete="current-password" value={platformPassword} onChange={(event) => setPlatformPassword(event.target.value)} />
          </label>
          <Typography.Text type="secondary">
            登录成功后服务端创建 HttpOnly 会话。退出登录会撤销当前会话，密码不会保存到浏览器。
          </Typography.Text>
          {dataSource ? (
            <Typography.Text type="secondary">
              当前数据源：{dataSource.persistence === "postgres" ? "Postgres" : dataSource.persistence ?? "未识别"}
            </Typography.Text>
          ) : null}
        </Space>
      </Modal>
    </Layout.Header>
  );
}
