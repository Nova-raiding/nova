import { useRef, useState } from "react";
import { Alert, Button, Card, Form, Input, message, Modal, Space, Table, Tag, Typography } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import { platformLabels, platforms, type Platform, type Rule } from "../../types/ops";

interface RuleCenterSectionProps {
  model: OpsConsoleModel;
}

const initialChecksJson = '{"forbiddenTerms":[]}';
const platformByMarkdownName = new Map<string, Platform>(
  platforms.flatMap((platform) => [
    [platform, platform] as const,
    [platformLabels[platform], platform] as const,
  ]),
);

function resolveMarkdownPlatform(value: string, cardId: string): Platform {
  const normalized = value.trim();
  const platform = platformByMarkdownName.get(normalized) ?? platformByMarkdownName.get(normalized.toLowerCase());
  if (!platform) throw new Error(`${cardId} 的平台“${normalized}”不受支持；请使用受支持的平台英文 id 或中文名称`);
  return platform;
}

export function isTrustedPlatformRule(rule: Pick<Rule, "source">) {
  return rule.source.trust === "verified"
    && ((rule.source.kind === "official" && !rule.source.reference.startsWith("manual://"))
      || (rule.source.kind === "internal" && rule.source.reference.startsWith("manual://")));
}

export function ruleTrustLabel(rule: Pick<Rule, "source">) {
  if (rule.source.trust !== "verified") return "未核验";
  if (rule.source.kind === "official" && !rule.source.reference.startsWith("manual://")) return "签名来源已验证";
  if (rule.source.kind === "internal" && rule.source.reference.startsWith("manual://")) return "人工已审批";
  return "来源类型不匹配";
}

export function canActivateOfficialPlatformRule(rule: Pick<Rule, "source" | "status" | "activationEligible">) {
  return rule.status !== "active" && rule.status !== "expired" && rule.activationEligible === true;
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

export function parseMarkdownDraftInputs(markdown: string, fileName: string) {
  const cards = [...markdown.matchAll(/^##\s+(PDD-[A-Z0-9-]+)｜(.+)$/gmu)];
  if (!cards.length) throw new Error("未识别到规则卡片；请使用 ## PDD-xxx｜规则名称 格式");
  const version = markdown.match(/知识库\s+v([\w.-]+)/u)?.[1] ?? "imported";
  return cards.map((card, index) => {
    const cardId = card[1] ?? `PDD-${index + 1}`;
    const body = markdown.slice((card.index ?? 0) + card[0].length, cards[index + 1]?.index ?? markdown.length).trim();
    const platform = body.match(/^- 平台：([^；\n]+)/mu)?.[1]?.trim();
    const source = body.match(/^- 官方依据：(.+)$/mu)?.[1]?.trim();
    if (!platform || !source) throw new Error(`${cardId} 缺少平台或官方依据字段`);
    const targetId = resolveMarkdownPlatform(platform, cardId);
    return {
      packId: `${targetId}-manual-${cardId.toLowerCase()}`,
      name: card[2]?.trim() || cardId,
      version,
      category: "platform" as const,
      publicScope: "platform" as const,
      targetId,
      sourceReference: `manual://${fileName}#${cardId}`,
      checksJson: JSON.stringify({ platform, source, content: `${card[0]}\n${body}` }),
      reason: `运营上传平台规则草稿：${fileName}`,
    };
  });
}

export async function uploadMarkdownDrafts(
  drafts: ReturnType<typeof parseMarkdownDraftInputs>,
  publishRuleDraft: (draft: ReturnType<typeof parseMarkdownDraftInputs>[number]) => Promise<boolean>,
) {
  let succeeded = 0;
  for (const draft of drafts) {
    if (!(await publishRuleDraft(draft))) {
      return {
        succeeded,
        failedCard: draft.packId.replace(/^.*-manual-/u, ""),
        reason: "规则服务拒绝了该卡片；请查看规则服务错误提示并核对官方依据。",
      };
    }
    succeeded += 1;
  }
  return { succeeded, failedCard: undefined, reason: undefined };
}

export function RuleCenterSection({ model }: RuleCenterSectionProps) {
  const { canRules, ruleMutationKey, rules, updateRuleStatus, publishRuleDraft } =
    model;
  const markdownInputRef = useRef<HTMLInputElement>(null);
  const [markdownImporting, setMarkdownImporting] = useState(false);
  const [markdownImportResult, setMarkdownImportResult] = useState<{ succeeded: number; failedCard?: string; reason?: string }>();
  const [activationTarget, setActivationTarget] = useState<Rule>();
  const [activationForm] = Form.useForm<{ approvalRef: string; approvedBy: string; approvedAt: string; reason: string; approvalToken: string }>();
  const unverifiedRules = rules.filter((rule) => !isTrustedPlatformRule(rule));
  const verifiedRules = rules.filter((rule) => !unverifiedRules.includes(rule));

  const activateRule = async () => {
    if (!activationTarget) return;
    const values = await activationForm.validateFields();
    const activated = await updateRuleStatus(activationTarget, "active", {
      reason: values.reason,
      approvalRef: values.approvalRef,
      approvedBy: values.approvedBy,
      approvedAt: values.approvedAt,
      // Read out of the form at submit time only; never mirrored into component
      // state, never handed to a persistence helper. The success path below
      // clears it together with the rest of the form, and the failure path keeps
      // it so the operator can resubmit the same evidence.
      ruleApprovalToken: values.approvalToken,
    });
    if (!activated) return;
    setActivationTarget(undefined);
    activationForm.resetFields();
  };

  const importMarkdownDrafts = async (file: File) => {
    if (!canRules || markdownImporting) return;
    setMarkdownImporting(true);
    setMarkdownImportResult(undefined);
    try {
      const markdown = await file.text();
      // Parse and validate the complete document before the first write. A
      // malformed later card must not leave an earlier card persisted.
      const drafts = parseMarkdownDraftInputs(markdown, file.name);
      setMarkdownImportResult(await uploadMarkdownDrafts(drafts, publishRuleDraft));
    } catch (error) {
      const reason = error instanceof Error ? error.message : "平台规则文件导入失败";
      setMarkdownImportResult({ succeeded: 0, failedCard: reason.match(/^(PDD-[A-Z0-9-]+)/u)?.[1], reason });
      message.error(reason);
    } finally {
      setMarkdownImporting(false);
      if (markdownInputRef.current) markdownInputRef.current.value = "";
    }
  };

  return (
    <Card
      title="规则中心"
      extra={
        <Space>
          <input ref={markdownInputRef} type="file" accept=".md,text/markdown" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importMarkdownDrafts(file); }} />
          <Button disabled={!canRules || markdownImporting} loading={markdownImporting} onClick={() => markdownInputRef.current?.click()}>上传平台规则 Markdown</Button>
          <Tag color={unverifiedRules.length ? "orange" : rules.length ? "green" : "orange"}>
            {unverifiedRules.length ? `${unverifiedRules.length} 条未验证（不展示）` : `${verifiedRules.length} 条可信规则`}
          </Tag>
        </Space>
      }
    >
      {unverifiedRules.length ? (
        <Alert
          type="warning"
          showIcon
          title="当前列表含本地演示/人工录入规则，不是平台官方规则"
          description="未审批的 manual:// 来源只是人工草稿，不会进入商家插件。独立审批只表示平台运营审核过提交材料，不代表系统已独立核验来源网站；生效范围为所有商家。"
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
      <Alert type="info" showIcon title="平台规则人工导入说明" description="上传文件只会创建带官方依据的公共草稿；规则管理员完成独立审批后才会进入商家规则、生成预检和发布前复检。未审批或来源不匹配的人工材料始终保持阻断。商家自己的运营约束仍应在工作区知识库维护，不能替代平台限制。" style={{ marginBottom: 16 }} />
      {markdownImportResult ? (
        <Alert
          showIcon
          type={markdownImportResult.failedCard ? "error" : "success"}
          role="status"
          title={markdownImportResult.failedCard ? "Markdown 导入未完成" : "Markdown 草稿导入完成"}
          description={`成功 ${markdownImportResult.succeeded} 张${markdownImportResult.failedCard ? `；失败卡片 ${markdownImportResult.failedCard}：${markdownImportResult.reason}` : "；没有失败卡片"}`}
          style={{ marginBottom: 16 }}
        />
      ) : null}
      <Table
        rowKey="id"
        pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => `共 ${total} 条` }}
        dataSource={rules}
        locale={{ emptyText: "暂无已生效平台规则；可配置签名清单同步，或上传 Markdown 保存内部待核验草稿（不会进入商家插件）" }}
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
                <Tag color={row.source.trust !== "verified" ? "orange" : row.source.kind === "internal" && row.source.reference.startsWith("manual://") ? "blue" : ruleTrustLabel(row) === "签名来源已验证" ? "green" : "red"}>{ruleTrustLabel(row)}</Tag>
              </Space>
            ),
          },
          {
            title: "来源",
            render: (_: unknown, row: Rule) =>
              `${ruleTrustLabel(row)} · ${row.source.kind} / ${row.source.reference}`,
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
                {canActivateOfficialPlatformRule(row) ? (
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
        {/* The form used to take the approver's name, a reference and a timestamp
            as free text, which is exactly the forgeable interaction: nothing
            proved an approval act happened, so under AUTH_ENFORCEMENT=strict the
            control could never succeed (parseApprovalGrant throws
            RULE_APPROVAL_REQUIRED without the token header). The proof is now a
            server-issued token the approver holds; the typed approver id is kept
            only because the server still requires `approved_by` in the body and
            rejects it when it disagrees with the grant. */}
        <Alert
          showIcon
          type="warning"
          role="status"
          title="审批证明来自审批人令牌，而不是表单里的姓名"
          description="服务端只从 x-rule-approval-token 请求头解析审批人，并要求它与下方“审批人 ID”一致；不一致或自审批会被拒绝（RULE_APPROVAL_INVALID / RULE_SEPARATION_OF_DUTIES_REQUIRED）。令牌由规则治理管理员发放给审批人本人。"
          style={{ marginBottom: 16 }}
        />
        <Form name="rule-activation-approval" form={activationForm} layout="vertical" aria-label="规则激活审批">
          <Form.Item name="approvalToken" label="审批人令牌" rules={[{ required: true, whitespace: true, message: "请填写审批人令牌" }]}>
            <Input.Password autoComplete="off" placeholder="由审批人提供的令牌" />
          </Form.Item>
          <Form.Item name="approvedBy" label="审批人 ID" extra="必须与令牌绑定的审批人一致；不一致时服务端拒绝整次激活" rules={[{ required: true, message: "请输入令牌绑定的审批人 ID" }]}>
            <Input placeholder="令牌绑定的审批人 ID" />
          </Form.Item>
          <Form.Item name="approvalRef" label="审批引用" extra="服务端仍要求该字段；仅作审批记录留存，不是审批证明" rules={[{ required: true, message: "请输入审批引用" }]}>
            <Input placeholder="工单或审批记录 ID" />
          </Form.Item>
          <Form.Item name="approvedAt" label="审批时间" extra="仅为记录：审批证明来自令牌，本字段不参与服务端审批判定" rules={[{ required: true, message: "请输入 ISO 8601 审批时间" }, { pattern: /^\d{4}-\d{2}-\d{2}T/u, message: "请输入 ISO 8601 时间" }]}>
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
