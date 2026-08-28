import { Button, Input, Layout, Space, Tag, Typography } from "antd";

interface OpsHeaderProps {
  managedSession: boolean;
  roles?: string[];
  sessionLoaded: boolean;
  onRefresh: () => void;
}

export function OpsHeader({
  managedSession,
  roles,
  sessionLoaded,
  onRefresh,
}: OpsHeaderProps) {
  const storage = managedSession ? sessionStorage : localStorage;

  return (
    <Layout.Header className="ops-header">
      <div>
        <Typography.Text className="eyebrow">
          WORKSPACE OPERATIONS
        </Typography.Text>
        <Typography.Title level={2}>商业与平台控制台</Typography.Title>
      </div>
      <Space wrap>
        <Input
          aria-label="工作区 ID"
          defaultValue={storage.getItem("ops_workspace_id") ?? "workspace_demo"}
          onChange={(event) =>
            storage.setItem("ops_workspace_id", event.target.value)
          }
          placeholder="工作区 ID"
        />
        {managedSession ? (
          <Tag color="green">SSO 托管会话</Tag>
        ) : (
          <>
            <Input
              aria-label="操作员 ID"
              defaultValue={
                localStorage.getItem("ops_actor_id") ?? "operator_demo"
              }
              onChange={(event) =>
                localStorage.setItem("ops_actor_id", event.target.value)
              }
              placeholder="操作员 ID"
            />
            <Input.Password
              aria-label="运营 API Token"
              placeholder="运营 Bearer token（仅存本机）"
              onChange={(event) =>
                localStorage.setItem("ops_api_token", event.target.value)
              }
            />
          </>
        )}
        <Tag color={managedSession && !sessionLoaded ? "orange" : "blue"}>
          {sessionLoaded
            ? `角色：${roles?.join("、") || "未声明"}`
            : managedSession
              ? "正在读取角色"
              : "本地管理员演示"}
        </Tag>
        <Button onClick={onRefresh}>刷新数据</Button>
      </Space>
    </Layout.Header>
  );
}
