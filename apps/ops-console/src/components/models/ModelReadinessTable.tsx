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
        pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => `共 ${total} 条` }}
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
            title: "配置与额度门禁",
            dataIndex: "ready",
            width: 150,
            render: (ready: boolean) => (
              <Tag color={ready ? "green" : "red"}>
                {ready ? "门禁通过" : "阻断"}
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
      <Alert
        type="info"
        showIcon
        title="真实生成尚未验证"
        description="配置与额度门禁通过不代表模型已成功推理；本状态未执行真实生成 canary。"
      />
      {status && (
        <Alert
          type={costReadiness.ready ? "success" : "error"}
          showIcon
          title={`成本与计费组：${costReadiness.ready ? "已就绪" : "阻断"}`}
          description={
            costReadiness.ready
              ? "平台成本上限与各模态成本证据配置门禁已通过。实际调用用量和成本仍须在财务对账中核验；本状态不能替代真实账单回执。"
              : costReadiness.blockers.join("；") ||
                "平台成本上限或成本证据配置门禁尚未通过；请在财务对账中核验实际账单回执。"
          }
        />
      )}
    </>
  );
}
