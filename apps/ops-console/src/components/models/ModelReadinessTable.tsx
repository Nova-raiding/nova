import { Alert, Table, Tag } from "antd";
import type { ModelStatus } from "../../types/ops";
import {
  modelCostReadiness,
  modelReadinessRows,
  type ModelReadinessRow,
} from "../sections/overview/modelReadiness";

interface ModelReadinessTableProps {
  status: ModelStatus | undefined;
}

export function ModelReadinessTable({ status }: ModelReadinessTableProps) {
  const readinessRows = modelReadinessRows(status);
  const costReadiness = modelCostReadiness(status);

  return (
    <>
      <Table<ModelReadinessRow>
        rowKey="key"
        size="small"
        pagination={false}
        scroll={{ x: 720 }}
        dataSource={readinessRows}
        columns={[
          { title: "能力", dataIndex: "label", width: 120 },
          {
            title: "Provider 配置",
            dataIndex: "providerConfigured",
            width: 150,
            render: (configured: boolean) => (
              <Tag color={configured ? "blue" : "default"}>
                {configured ? "已配置" : "未配置"}
              </Tag>
            ),
          },
          {
            title: "最终 readiness",
            dataIndex: "ready",
            width: 150,
            render: (ready: boolean) => (
              <Tag color={ready ? "green" : "red"}>
                {ready ? "可用" : "阻断"}
              </Tag>
            ),
          },
          {
            title: "阻断原因",
            dataIndex: "reasons",
            render: (reasons: string[], row: ModelReadinessRow) =>
              row.ready
                ? "—"
                : reasons.join("；") || "尚未通过最终运行与商业门禁",
          },
        ]}
      />
      {status && (
        <Alert
          type={costReadiness.ready ? "success" : "error"}
          showIcon
          title={`成本与计费组：${costReadiness.ready ? "已就绪" : "阻断"}`}
          description={
            costReadiness.ready
              ? "成本上限、实际成本证据和当前计费组均已通过门禁。"
              : costReadiness.blockers.join("；") ||
                "实际成本证据、价格快照或当前计费组尚未通过验证。"
          }
        />
      )}
    </>
  );
}
