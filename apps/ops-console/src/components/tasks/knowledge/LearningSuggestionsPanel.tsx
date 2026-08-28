import { Button, Input, Modal, Space, Table, Typography } from "antd";
import { useState } from "react";
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
  const [dismissTarget, setDismissTarget] = useState<LearningSuggestion>();
  const [dismissReason, setDismissReason] = useState("当前证据不足，不沉淀为规则");
  const [dismissing, setDismissing] = useState(false);
  const closeDismiss = () => { if (!dismissing) { setDismissTarget(undefined); setDismissReason(""); } };
  const submitDismiss = async () => {
    if (!dismissTarget || dismissReason.trim().length < 4) return;
    setDismissing(true);
    const saved = await dismissLearning(dismissTarget, dismissReason);
    setDismissing(false);
    if (saved) closeDismiss();
  };

  return (
    <>
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
                onClick={() => { setDismissTarget(row); setDismissReason("当前证据不足，不沉淀为规则"); }}
              >
                驳回建议
              </Button>
            </Space>
          ),
        },
      ]}
    />
    <Modal title="驳回学习建议" open={Boolean(dismissTarget)} okText="确认驳回" cancelText="取消" confirmLoading={dismissing} okButtonProps={{ danger: true, disabled: dismissReason.trim().length < 4 }} onCancel={closeDismiss} onOk={() => void submitDismiss()}>
      <Typography.Paragraph>驳回原因会写入真实运营审计，且不会自动沉淀为全局规则。</Typography.Paragraph>
      <label htmlFor="learning-dismiss-reason">驳回原因（至少 4 个字符）</label>
      <Input.TextArea id="learning-dismiss-reason" autoFocus rows={4} maxLength={500} showCount value={dismissReason} onChange={(event) => setDismissReason(event.target.value)} />
    </Modal>
    </>
  );
}
