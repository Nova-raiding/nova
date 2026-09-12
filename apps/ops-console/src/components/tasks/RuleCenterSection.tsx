import { useState } from "react";
import { Alert, Button, Card, Form, Input, Modal, Space, Table, Tag, Typography } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import type { Rule } from "../../types/ops";

interface RuleCenterSectionProps {
  model: OpsConsoleModel;
}

const initialChecksJson = '{"forbiddenTerms":[]}';

export function isOfficialPlatformRule(rule: Pick<Rule, "source">) {
  return rule.source.kind === "official" && rule.source.trust === "verified"
    && !rule.source.reference.startsWith("manual://");
}

function ruleStatusLabel(value: string | undefined): string {
  return ({ published: "已发布", draft: "草稿", active: "已启用", inactive: "已停用", expired: "已过期", unknown: "状态待确认" } as Record<string, string>)[value ?? ""] ?? "状态待确认";
}

export function validateRuleChecksJson(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return "请输入检查规则 JSON";
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "检查规则必须是 JSON 对象";
  } catch {
    return "检查规则必须是合法 JSON";
  }
  return undefined;
}

export function hasRuleDraftChanges(values: Readonly<Record<string, unknown>>) {
  return ["packId", "name", "version", "sourceReference", "reason"].some((key) => String(values[key] ?? "").trim())
    || (typeof values.checksJson === "string" && values.checksJson !== initialChecksJson);
}

export function RuleCenterSection({ model }: RuleCenterSectionProps) {
  const { canRules, ruleMutationKey, rules, updateRuleStatus } =
    model;
  const [activationTarget, setActivationTarget] = useState<Rule>();
  const [activationForm] = Form.useForm<{ approvalRef: string; approvedBy: string; approvedAt: string; reason: string }>();
  const unverifiedRules = rules.filter((rule) => !isOfficialPlatformRule(rule));
  const verifiedRules = rules.filter((rule) => !unverifiedRules.includes(rule));

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
        <Tag color={unverifiedRules.length ? "orange" : rules.length ? "green" : "orange"}>
          {unverifiedRules.length ? `${unverifiedRules.length} 条未验证（不展示）` : `${verifiedRules.length} 条可信规则`}
        </Tag>
      }
    >
      {unverifiedRules.length ? (
        <Alert
          type="warning"
          showIcon
          title="当前列表含本地演示/人工录入规则，不是平台官方规则"
          description="manual:// 来源只用于本地测试或人工草稿；不会作为插件的可信知识，也不会证明平台同步成功。只有通过签名规则清单导入的版本才会标记为“已验证”。"
          style={{ marginBottom: 16 }}
        />
      ) : null}
      {!canRules ? (
        <Alert
          type="info"
          showIcon
          title="当前为规则只读视图"
          description="平台运营可以查看规则同步状态和生命周期证据；创建、审批、激活和停用需要 rules_admin 权限。"
          style={{ marginBottom: 16 }}
        />
      ) : null}
      <Alert type="info" showIcon title="平台官方限制规则" description="平台、品类、广告发布及大促规则须来自可验证的官方来源；本页不创建商家自定义规则。商家运营约束请在工作区知识库维护，不能替代平台限制。" style={{ marginBottom: 16 }} />
      <Table
        rowKey="id"
        pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => `共 ${total} 条` }}
        dataSource={verifiedRules}
        locale={{ emptyText: "暂无已验证的平台限制规则；请配置官方签名清单后点击“立即更新”" }}
        scroll={{ x: 900 }}
        columns={[
          { title: "规则包", dataIndex: "packId" },
          { title: "名称", dataIndex: "name" },
          { title: "版本", dataIndex: "version" },
          {
            title: "生命周期",
            render: (_: unknown, row: Rule) => (
              <Space size={4}>
                <Tag color={row.lifecycleStatus === "published" ? "green" : "orange"}>{ruleStatusLabel(row.lifecycleStatus ?? row.status)}</Tag>
                {row.source.trust !== "verified" || row.source.reference.startsWith("manual://") ? <Tag color="orange">未验证</Tag> : <Tag color="green">已验证</Tag>}
              </Space>
            ),
          },
          {
            title: "来源",
            render: (_: unknown, row: Rule) =>
              `${row.source.trust === "verified" ? "已验证" : "未验证"} · ${row.source.kind} / ${row.source.reference}`,
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
