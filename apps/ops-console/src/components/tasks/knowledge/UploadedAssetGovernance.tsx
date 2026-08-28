import { Button, Card, Table, Tag } from "antd";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel";
import type { UploadedAssetRisk } from "../../../types/ops";

interface UploadedAssetGovernanceProps {
  model: OpsConsoleModel;
}

export function UploadedAssetGovernance({
  model,
}: UploadedAssetGovernanceProps) {
  const { canKnowledge, governUploadedAsset, marketingQueue } = model;

  return (
    <Card title="上传素材治理动作" size="small">
      <Table
        rowKey="id"
        pagination={{ pageSize: 6 }}
        dataSource={marketingQueue.uploadedAssetRisks}
        columns={[
          { title: "素材", dataIndex: "name" },
          {
            title: "安全/解析/权益",
            render: (_: unknown, row: UploadedAssetRisk) =>
              `${row.scanStatus} / ${row.parseStatus} / ${row.rightsStatus}`,
          },
          {
            title: "就绪状态",
            dataIndex: "readiness.status",
            render: (_: unknown, row: UploadedAssetRisk) => (
              <Tag
                color={row.readiness.status === "ready" ? "green" : "orange"}
              >
                {row.readiness.status}
              </Tag>
            ),
          },
          {
            title: "下一步",
            render: (_: unknown, row: UploadedAssetRisk) =>
              row.nextAction?.label ?? row.nextStep ?? "-",
          },
          {
            title: "操作",
            render: (_: unknown, row: UploadedAssetRisk) => (
              <Button
                type="link"
                disabled={!canKnowledge || !row.nextAction}
                onClick={() => void governUploadedAsset(row)}
              >
                执行治理动作
              </Button>
            ),
          },
        ]}
      />
    </Card>
  );
}
