import { Button, Card, Form, Input, Space, Table, Tag, Typography } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import type { Rule } from "../../types/ops";

interface RuleCenterSectionProps {
  model: OpsConsoleModel;
}

export function RuleCenterSection({ model }: RuleCenterSectionProps) {
  const { canRules, publishRuleDraft, ruleForm, rules, updateRuleStatus } =
    model;

  return (
    <Card
      title="规则中心"
      extra={
        <Tag color={rules.length ? "green" : "orange"}>
          {rules.length} 条生效规则
        </Tag>
      }
    >
      <Form
        form={ruleForm}
        layout="inline"
        onFinish={publishRuleDraft}
        style={{ marginBottom: 16 }}
        disabled={!canRules}
      >
        <Form.Item name="packId" rules={[{ required: true }]}>
          <Input placeholder="规则包 ID" />
        </Form.Item>
        <Form.Item name="name" rules={[{ required: true }]}>
          <Input placeholder="规则名称" />
        </Form.Item>
        <Form.Item name="version" rules={[{ required: true }]}>
          <Input placeholder="版本" />
        </Form.Item>
        <Form.Item name="sourceReference" rules={[{ required: true }]}>
          <Input placeholder="来源链接/工单" />
        </Form.Item>
        <Form.Item
          name="checksJson"
          initialValue='{"forbiddenTerms":[]}'
          rules={[{ required: true }]}
        >
          <Input placeholder="checks JSON" />
        </Form.Item>
        <Form.Item name="reason" rules={[{ required: true }]}>
          <Input placeholder="发布原因" />
        </Form.Item>
        <Button disabled={!canRules} type="primary" htmlType="submit">
          创建规则草稿
        </Button>
      </Form>
      <Table
        rowKey="id"
        pagination={{ pageSize: 8 }}
        dataSource={rules}
        columns={[
          { title: "规则包", dataIndex: "packId" },
          { title: "名称", dataIndex: "name" },
          { title: "版本", dataIndex: "version" },
          {
            title: "生命周期",
            render: (_: unknown, row: Rule) => (
              <Tag
                color={row.lifecycleStatus === "published" ? "green" : "orange"}
              >
                {row.lifecycleStatus ?? row.status}
              </Tag>
            ),
          },
          {
            title: "来源",
            render: (_: unknown, row: Rule) =>
              `${row.source.kind} / ${row.source.reference}`,
          },
          {
            title: "有效期",
            render: (_: unknown, row: Rule) =>
              `${row.effectiveFrom ?? "-"} 至 ${row.effectiveTo ?? "-"}`,
          },
          {
            title: "操作",
            render: (_: unknown, row: Rule) => (
              <Space>
                <Button
                  disabled={!canRules}
                  type="link"
                  onClick={() => void updateRuleStatus(row, "expired")}
                >
                  标记过期
                </Button>
                <Button
                  disabled={!canRules}
                  type="link"
                  danger
                  onClick={() => void updateRuleStatus(row, "inactive")}
                >
                  停用
                </Button>
              </Space>
            ),
          },
        ]}
      />
      <Typography.Text type="secondary">
        草稿发布不代表已生效；规则激活必须由服务端规则管理员提供审批凭证，所有状态变更写入审计。
      </Typography.Text>
    </Card>
  );
}
