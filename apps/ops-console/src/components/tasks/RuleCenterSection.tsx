import { useEffect, useState } from "react";
import { Alert, Button, Card, Form, Input, Modal, Space, Table, Tag, Typography } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import type { Rule } from "../../types/ops";
import { useUnsavedChanges } from "../authz/UnsavedChangesContext.js";

interface RuleCenterSectionProps {
  model: OpsConsoleModel;
}

const initialChecksJson = '{"forbiddenTerms":[]}';

export function hasRuleDraftChanges(values: Readonly<Record<string, unknown>>) {
  return ["packId", "name", "version", "sourceReference", "reason"].some((key) => String(values[key] ?? "").trim())
    || (typeof values.checksJson === "string" && values.checksJson !== initialChecksJson);
}

export function RuleCenterSection({ model }: RuleCenterSectionProps) {
  const { canRules, publishRuleDraft, ruleForm, ruleMutationKey, rules, updateRuleStatus } =
    model;
  const [activationTarget, setActivationTarget] = useState<Rule>();
  const [activationForm] = Form.useForm<{ approvalRef: string; approvedBy: string; approvedAt: string; reason: string }>();
  const [draftDirty, setDraftDirty] = useState(false);
  useEffect(() => {
    // The form instance belongs to the page model and can survive a transient
    // authorization remount even when AntD resets its touched metadata.
    setDraftDirty(hasRuleDraftChanges(ruleForm.getFieldsValue(true)));
  }, [ruleForm]);
  useUnsavedChanges(draftDirty, "规则草稿表单");

  const activateRule = async () => {
    if (!activationTarget) return;
    const values = await activationForm.validateFields();
    const activated = await updateRuleStatus(activationTarget, "active", values);
    if (!activated) return;
    setActivationTarget(undefined);
    activationForm.resetFields();
  };

  return (
    <Card
      title="规则中心"
      extra={
        <Tag color={rules.length ? "green" : "orange"}>
          {rules.length} 条生效规则
        </Tag>
      }
    >
      {!canRules ? (
        <Alert
          type="info"
          showIcon
          message="当前为规则只读视图"
          description="平台运营可以查看规则同步状态和生命周期证据；创建、审批、激活和停用需要 rules_admin 权限。"
          style={{ marginBottom: 16 }}
        />
      ) : null}
      <Form
        name="rule-draft-create"
        form={ruleForm}
        layout="inline"
        onValuesChange={() => setDraftDirty(true)}
        onFinish={async (values) => {
          await publishRuleDraft(values);
          setDraftDirty(false);
        }}
        onFinishFailed={({ errorFields }) => {
          const first = errorFields[0]?.name;
          if (first) ruleForm.scrollToField(first, { block: "center", focus: true });
        }}
        style={{ marginBottom: 16 }}
        disabled={!canRules || Boolean(ruleMutationKey)}
        aria-label="创建规则草稿"
      >
        <Form.Item name="packId" label="规则包 ID" rules={[{ required: true, message: "请输入规则包 ID" }]}> 
          <Input placeholder="规则包 ID" />
        </Form.Item>
        <Form.Item name="name" label="规则名称" rules={[{ required: true, message: "请输入规则名称" }]}> 
          <Input placeholder="规则名称" />
        </Form.Item>
        <Form.Item name="version" label="版本" rules={[{ required: true, message: "请输入规则版本" }]}> 
          <Input placeholder="版本" />
        </Form.Item>
        <Form.Item name="sourceReference" label="来源" rules={[{ required: true, message: "请输入来源链接或工单号" }]}> 
          <Input placeholder="来源链接/工单" />
        </Form.Item>
        <Form.Item
          name="checksJson"
          label="检查规则"
          initialValue={initialChecksJson}
          rules={[{ required: true, message: "请输入检查规则 JSON" }]}
        >
          <Input placeholder="checks JSON" />
        </Form.Item>
        <Form.Item name="reason" label="创建原因" rules={[{ required: true, message: "请输入创建原因" }]}> 
          <Input placeholder="发布原因" />
        </Form.Item>
        <Button disabled={!canRules || Boolean(ruleMutationKey)} loading={ruleMutationKey === "draft"} type="primary" htmlType="submit">
          创建规则草稿
        </Button>
      </Form>
      <Table
        rowKey="id"
        pagination={{ pageSize: 8 }}
        dataSource={rules}
        locale={{ emptyText: "尚无规则草稿；请先填写来源和检查规则后创建" }}
        scroll={{ x: 900 }}
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
                {row.status !== "active" && row.status !== "expired" ? (
                  <Button
                    disabled={!canRules || Boolean(ruleMutationKey)}
                    loading={ruleMutationKey === `${row.id}:active`}
                    type="link"
                    onClick={() => setActivationTarget(row)}
                  >
                    审批并激活
                  </Button>
                ) : null}
                <Button
                  disabled={!canRules || Boolean(ruleMutationKey)}
                  loading={ruleMutationKey === `${row.id}:expired`}
                  type="link"
                  onClick={() => void updateRuleStatus(row, "expired")}
                >
                  标记过期
                </Button>
                <Button
                  disabled={!canRules || Boolean(ruleMutationKey)}
                  loading={ruleMutationKey === `${row.id}:inactive`}
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
      <Modal
        title="审批并激活规则"
        open={Boolean(activationTarget)}
        okText="确认激活"
        cancelText="取消"
        confirmLoading={ruleMutationKey === `${activationTarget?.id}:active`}
        onOk={() => void activateRule()}
        onCancel={() => {
          if (ruleMutationKey) return;
          setActivationTarget(undefined);
          activationForm.resetFields();
        }}
        destroyOnHidden
      >
        <Form name="rule-activation-approval" form={activationForm} layout="vertical" aria-label="规则激活审批">
          <Form.Item name="approvalRef" label="审批引用" rules={[{ required: true, message: "请输入审批引用" }]}>
            <Input placeholder="工单或审批记录 ID" />
          </Form.Item>
          <Form.Item name="approvedBy" label="审批人 ID" rules={[{ required: true, message: "请输入不同于当前操作者的审批人 ID" }]}>
            <Input placeholder="独立审批人 ID" />
          </Form.Item>
          <Form.Item name="approvedAt" label="审批时间" rules={[{ required: true, message: "请输入 ISO 8601 审批时间" }, { pattern: /^\d{4}-\d{2}-\d{2}T/u, message: "请输入 ISO 8601 时间" }]}>
            <Input placeholder="2026-08-29T08:00:00.000Z" />
          </Form.Item>
          <Form.Item name="reason" label="激活原因" rules={[{ required: true, message: "请输入激活原因" }]}>
            <Input.TextArea rows={3} placeholder="说明审批依据和生效范围" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
