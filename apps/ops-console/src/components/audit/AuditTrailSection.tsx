import { DownloadOutlined } from "@ant-design/icons";
import { Button, Card, Table, Tag, Typography } from "antd";
import type { Audit } from "../../types/ops";

interface AuditTrailSectionProps {
  audits: Audit[];
  canExport: boolean;
  onExport: () => void | Promise<unknown>;
}

export function AuditTrailSection({ audits, canExport, onExport }: AuditTrailSectionProps) {
  return (
    <Card
      title="平台操作审计"
      extra={
        <Button
          icon={<DownloadOutlined aria-hidden="true" />}
          disabled={!canExport}
          title={canExport ? undefined : "需要平台运营权限"}
          onClick={() => void onExport()}
        >
          导出审计
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">
        审计记录由服务端生成；前端只展示脱敏投影，不允许修改或删除历史记录。
      </Typography.Paragraph>
      <Table<Audit>
        rowKey="id"
        size="small"
        pagination={{ pageSize: 20, showSizeChanger: false }}
        locale={{ emptyText: "暂无平台操作审计记录" }}
        scroll={{ x: 980 }}
        dataSource={audits}
        columns={[
          {
            title: "时间",
            dataIndex: "createdAt",
            fixed: "left",
            width: 190,
            render: (value: string) => new Date(value).toLocaleString(),
          },
          { title: "操作者", dataIndex: "actorId", width: 180 },
          {
            title: "动作",
            dataIndex: "action",
            width: 220,
            render: (value: string) => <Tag>{value}</Tag>,
          },
          {
            title: "资源",
            width: 260,
            render: (_: unknown, row: Audit) => (
              <Typography.Text className="ops-token">
                {row.resourceType} / {row.resourceId}
              </Typography.Text>
            ),
          },
          { title: "原因", dataIndex: "reason", width: 320 },
        ]}
      />
    </Card>
  );
}
