import { Button, Form, Input, Select, Table, Tag } from "antd";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel";
import type { Rule } from "../../../types/ops";

interface KnowledgeRulesPanelProps {
  model: OpsConsoleModel;
}

export function KnowledgeRulesPanel({ model }: KnowledgeRulesPanelProps) {
  const { canRules, createKnowledgeRule, knowledgeRuleForm, knowledgeRules } =
    model;

  return (
    <>
      <Form
        form={knowledgeRuleForm}
        layout="inline"
        onFinish={createKnowledgeRule}
        disabled={!canRules}
        style={{ marginBottom: 16 }}
      >
        <Form.Item name="name" rules={[{ required: true }]}>
          <Input placeholder="规则名称" />
        </Form.Item>
        <Form.Item name="content" rules={[{ required: true }]}>
          <Input placeholder="规则内容" />
        </Form.Item>
        <Form.Item
          name="scope"
          initialValue="global"
          rules={[{ required: true }]}
        >
          <Select
            style={{ width: 130 }}
            options={[
              "global",
              "platform",
              "category",
              "brand",
              "store",
              "campaign",
            ].map((value) => ({ value, label: value }))}
          />
        </Form.Item>
        <Form.Item name="scopeValue">
          <Input placeholder="作用域值（可选）" />
        </Form.Item>
        <Form.Item name="sourceReference" rules={[{ required: true }]}>
          <Input placeholder="来源链接/工单" />
        </Form.Item>
        <Form.Item
          name="sourceCheckedAt"
          initialValue={new Date().toISOString()}
          rules={[{ required: true }]}
        >
          <Input placeholder="核验时间 ISO" />
        </Form.Item>
        <Form.Item
          name="version"
          initialValue="v1"
          rules={[{ required: true }]}
        >
          <Input placeholder="版本" />
        </Form.Item>
        <Form.Item
          name="status"
          initialValue="draft"
          rules={[{ required: true }]}
        >
          <Select
            style={{ width: 110 }}
            options={["draft", "active", "inactive", "archived"].map(
              (value) => ({ value, label: value }),
            )}
          />
        </Form.Item>
        <Button disabled={!canRules} type="primary" htmlType="submit">
          录入知识规则
        </Button>
      </Form>
      <Table
        rowKey="id"
        pagination={{ pageSize: 6 }}
        dataSource={knowledgeRules}
        columns={[
          { title: "规则", dataIndex: "name" },
          { title: "版本", dataIndex: "version" },
          {
            title: "作用域",
            render: (_: unknown, row: Rule) =>
              `${row.scope}${row.scopeValue ? ` / ${row.scopeValue}` : ""}`,
          },
          {
            title: "来源",
            render: (_: unknown, row: Rule) => row.source.reference,
          },
          {
            title: "状态",
            render: (_: unknown, row: Rule) => (
              <Tag color={row.status === "active" ? "green" : "orange"}>
                {row.status}
              </Tag>
            ),
          },
        ]}
      />
    </>
  );
}
