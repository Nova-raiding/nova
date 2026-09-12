import { Space, Typography } from "antd";

interface EnterpriseIdentityProps {
  name?: string;
  workspaceId?: string;
  copyable?: boolean;
}

export function EnterpriseIdentity({ name, workspaceId, copyable = true }: EnterpriseIdentityProps) {
  const displayName = name?.trim() || "未命名企业主体";
  return (
    <Space orientation="vertical" size={0}>
      <Typography.Text strong>{displayName}</Typography.Text>
      {workspaceId ? (
        <Typography.Text
          type="secondary"
          className="ops-token"
          copyable={copyable ? { text: workspaceId } : false}
        >
          Workspace ID：{workspaceId}
        </Typography.Text>
      ) : null}
    </Space>
  );
}
