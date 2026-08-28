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
        onFinishFailed={({ errorFields }) => {
          const first = errorFields[0]?.name;
          if (first) knowledgeRuleForm.scrollToField(first, { block: "center", focus: true });
        }}
        disabled={!canRules}
        style={{ marginBottom: 16 }}
        aria-label="录入知识规则"
      >
        <Form.Item name="name" label="规则名称" rules={[{ required: true, message: "请输入规则名称" }]}>
          <Input placeholder="规则名称" />
        </Form.Item>
        <Form.Item name="content" label="规则内容" rules={[{ required: true, message: "请输入规则内容" }]}>
          <Input placeholder="规则内容" />
        </Form.Item>
        <Form.Item
          name="scope"
          label="作用域"
          initialValue="global"
          rules={[{ required: true, message: "请选择作用域" }]}
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
            ].map((value) => ({ value, label: ({ global: "全局", platform: "平台", category: "品类", brand: "品牌", store: "店铺", campaign: "活动" } as Record<string, string>)[value] }))}
          />
        </Form.Item>
        <Form.Item name="scopeValue" label="作用域值">
          <Input placeholder="作用域值（可选）" />
        </Form.Item>
        <Form.Item name="sourceReference" label="来源" rules={[{ required: true, message: "请输入来源链接或工单号" }]}>
          <Input placeholder="来源链接/工单" />
        </Form.Item>
        <Form.Item
          name="sourceCheckedAt"
          label="核验时间"
          initialValue={new Date().toISOString()}
          rules={[{ required: true, message: "请输入核验时间" }]}
        >
          <Input placeholder="核验时间 ISO" />
        </Form.Item>
        <Form.Item
          name="version"
          label="版本"
          initialValue="v1"
          rules={[{ required: true, message: "请输入规则版本" }]}
        >
          <Input placeholder="版本" />
        </Form.Item>
        <Form.Item
          name="status"
          label="状态"
          initialValue="draft"
          rules={[{ required: true, message: "请选择规则状态" }]}
        >
          <Select
            style={{ width: 110 }}
            options={[{ value: "draft", label: "草稿" }, { value: "active", label: "生效" }, { value: "inactive", label: "停用" }, { value: "archived", label: "归档" }]}
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
        locale={{ emptyText: "尚未录入知识规则；完成上方来源核验后创建第一条规则" }}
        scroll={{ x: 720 }}
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
