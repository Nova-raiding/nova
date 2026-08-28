import { Button, Space, Table } from "antd";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel";
import type { LearningSuggestion } from "../../../types/ops";

interface LearningSuggestionsPanelProps {
  model: OpsConsoleModel;
}

export function LearningSuggestionsPanel({
  model,
}: LearningSuggestionsPanelProps) {
  const {
    canKnowledge,
    confirmLearning,
    dismissLearning,
    learningSuggestions,
  } = model;

  return (
    <Table
      rowKey="id"
      pagination={{ pageSize: 6 }}
      dataSource={learningSuggestions}
      columns={[
        { title: "建议", dataIndex: "summary" },
        {
          title: "作用域",
          render: (_: unknown, row: LearningSuggestion) =>
            `${row.proposedRule.scope}${row.proposedRule.scopeValue ? ` / ${row.proposedRule.scopeValue}` : ""}`,
        },
        { title: "证据", dataIndex: "feedbackId" },
        {
          title: "操作",
          render: (_: unknown, row: LearningSuggestion) => (
            <Space>
              <Button
                type="link"
                disabled={!canKnowledge}
                onClick={() => void confirmLearning(row)}
              >
                确认证据
              </Button>
              <Button
                type="link"
                danger
                disabled={!canKnowledge}
                onClick={() => void dismissLearning(row)}
              >
                驳回建议
              </Button>
            </Space>
          ),
        },
      ]}
    />
  );
}
