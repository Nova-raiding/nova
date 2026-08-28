import { Button, Input, Layout, Space, Tag, Typography } from "antd";
import { hasOpsConnection, hasOpsCredentials, opsApiBase } from "../api/opsClient.js";
import type { OpsDataSource } from "../types/ops.js";

interface OpsHeaderProps {
  managedSession: boolean;
  roles?: string[];
  sessionLoaded: boolean;
  onRefresh: () => void;
  dataSource?: OpsDataSource;
}

export function OpsHeader({
  managedSession,
  roles,
  sessionLoaded,
  onRefresh,
  dataSource,
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
      <form
        className="ops-connection-form"
        aria-label="运营 API 连接配置"
        onSubmit={(event) => event.preventDefault()}
      >
      <Space wrap>
        <Input
          aria-label="运营 API 地址"
          defaultValue={opsApiBase()}
          onChange={(event) =>
            localStorage.setItem("ops_api_base", event.target.value)
          }
          placeholder="真实运营 API 地址"
        />
        <Input
          aria-label="工作区 ID"
          defaultValue={storage.getItem("ops_workspace_id") ?? ""}
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
              autoComplete="username"
              defaultValue={
                localStorage.getItem("ops_actor_id") ?? ""
              }
              onChange={(event) =>
                localStorage.setItem("ops_actor_id", event.target.value)
              }
              placeholder="操作员 ID"
            />
            <Input.Password
              aria-label="运营 API Token"
              autoComplete="current-password"
              placeholder="运营 Bearer token（仅存本机）"
              onChange={(event) =>
                localStorage.setItem("ops_api_token", event.target.value)
              }
            />
          </>
        )}
        <Tag color={!hasOpsConnection() ? "orange" : managedSession && !sessionLoaded ? "orange" : "blue"}>
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
          <Tag color={dataSource.fixtureDataPresent ? "orange" : dataSource.persistence === "postgres" ? "green" : "gold"}>
            {dataSource.fixtureDataPresent
              ? `Postgres/API · 含演示数据（真实店铺 ${dataSource.officialStoreCount ?? 0}，演示店铺 ${dataSource.fixtureStoreCount ?? 0}）`
              : dataSource.persistence === "postgres"
                ? "真实 Postgres/API 数据"
                : `非生产数据：${dataSource.persistence ?? "未识别"}`}
          </Tag>
        ) : null}
        <Button onClick={onRefresh}>刷新数据</Button>
      </Space>
      </form>
    </Layout.Header>
  );
}
