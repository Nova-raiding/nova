import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Descriptions, Empty, Input, Select, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { rpc } from "../../api/opsClient.js";
import type { AuthorizationProjection } from "../../authz/authorization.js";
import { platformLabels, platforms, type Platform } from "../../types/ops.js";

type ReviewRule = {
  id: string; platform: Platform; pack_id: string; name: string; version: string; status: string;
  source: { kind: string; reference: string; checked_at: string; trust: string };
  checks?: Record<string, unknown>; checksum: string; checksum_valid: boolean; created_by: string; created_at: string;
  revision: number; severity?: string; action?: string;
};
type ReviewAudit = { id: string; action: string; actor_id: string; reason?: string; occurred_at: string; data: Record<string, unknown> };
type ReviewDetail = { rule: ReviewRule; audit: ReviewAudit[] };

export function parsePublicRuleDraftList(value: unknown): { items: ReviewRule[]; nextCursor?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("公共规则草稿列表响应格式无效");
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.items)) throw new Error("公共规则草稿列表缺少 items");
  for (const item of result.items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("公共规则草稿记录格式无效");
    const row = item as Record<string, unknown>;
    if (!["id", "platform", "pack_id", "name", "version", "status", "checksum", "created_by", "created_at"].every(key => typeof row[key] === "string")
      || typeof row.checksum_valid !== "boolean" || !row.source || typeof row.source !== "object" || Array.isArray(row.source)
      || !["kind", "reference", "checked_at", "trust"].every(key => typeof (row.source as Record<string, unknown>)[key] === "string")) throw new Error("公共规则草稿记录字段不完整");
  }
  if (result.next_cursor !== undefined && typeof result.next_cursor !== "string") throw new Error("公共规则草稿游标格式无效");
  return { items: result.items as ReviewRule[], ...(typeof result.next_cursor === "string" ? { nextCursor: result.next_cursor } : {}) };
}

function parsePublicRuleDraftDetail(value: unknown): ReviewDetail {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("公共规则详情响应格式无效");
  const result = value as Record<string, unknown>;
  const listShape = parsePublicRuleDraftList({ items: result.rule ? [result.rule] : [] });
  if (!listShape.items[0] || !Array.isArray(result.audit)) throw new Error("公共规则详情缺少规则或审核记录");
  if (!result.audit.every(event => event && typeof event === "object" && !Array.isArray(event)
    && ["id", "action", "actor_id", "occurred_at"].every(key => typeof (event as Record<string, unknown>)[key] === "string"))) throw new Error("公共规则审核记录格式无效");
  const rule = listShape.items[0];
  if (!rule.checks || typeof rule.checks !== "object" || Array.isArray(rule.checks)
    || !Number.isSafeInteger(rule.revision) || !Number.isFinite(Date.parse(rule.created_at))) throw new Error("公共规则详情字段不完整");
  return { rule, audit: result.audit as ReviewAudit[] };
}

export function canReviewPublicRuleDraft(authorization: AuthorizationProjection, rule: ReviewRule) {
  return authorization.scope.kind === "platform" && authorization.can("rule.read")
    && authorization.can("rule.update") && rule.status === "draft" && rule.checksum_valid
    && ["manual_pending_review", "signed_import"].includes(rule.source.trust);
}

export function buildPublicRuleStatusParams(rule: ReviewRule, status: "active" | "inactive", reason: string, approval?: { approvalRef: string; approvedBy: string; approvedAt: string }) {
  return {
    pack_id: rule.pack_id,
    version: rule.version,
    status,
    public_scope: "platform",
    platform: rule.platform,
    expected_revision: String(rule.revision),
    reason,
    ...(status === "active" && approval ? { approval_json: JSON.stringify({ approval_ref: approval.approvalRef, approved_by: approval.approvedBy, approved_at: approval.approvedAt }) } : {}),
  };
}

const columns: ColumnsType<ReviewRule> = [
  { title: "平台", dataIndex: "platform", render: (value: Platform) => platformLabels[value] ?? value },
  { title: "规则包", dataIndex: "pack_id", render: (value: string) => <Typography.Text code copyable>{value}</Typography.Text> },
  { title: "名称", dataIndex: "name" },
  { title: "版本", dataIndex: "version" },
  { title: "来源状态", dataIndex: ["source", "trust"], render: (value: string) => value === "manual_pending_review" ? <Tag color="orange">人工待审核</Tag> : value === "signed_import" ? <Tag color="green">签名导入</Tag> : <Tag color="red">未验证</Tag> },
  { title: "完整性", dataIndex: "checksum_valid", render: (value: boolean) => value ? <Tag color="green">校验通过</Tag> : <Tag color="red">校验失败</Tag> },
  { title: "提交时间", dataIndex: "created_at", render: (value: string) => new Date(value).toLocaleString() },
];

export function PublicRuleDraftReviewPanel({ authorization }: { authorization: AuthorizationProjection }) {
  const visible = authorization.scope.kind === "platform" && authorization.can("rule.read");
  const canWrite = visible && authorization.can("rule.update");
  const canApprove = canWrite && authorization.can("rule.publish.approve");
  const [platform, setPlatform] = useState<Platform | "">("");
  const [items, setItems] = useState<ReviewRule[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [detail, setDetail] = useState<ReviewDetail>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const listRequest = useRef(0);
  const [approvalRef, setApprovalRef] = useState("");
  const [approvedBy, setApprovedBy] = useState("");
  const [approvedAt, setApprovedAt] = useState("");
  const [reason, setReason] = useState("");
  const [approvalToken, setApprovalToken] = useState("");

  const load = async (cursor?: string) => {
    if (!visible) return;
    const requestId = ++listRequest.current;
    setLoading(true); setError("");
    try {
      const response = await rpc<unknown>("ops.rules.public.drafts.list", { ...(platform ? { platform } : {}), limit: "50", ...(cursor ? { cursor } : {}) });
      const parsed = parsePublicRuleDraftList(response);
      if (requestId !== listRequest.current) return;
      setItems(current => cursor ? [...current, ...parsed.items] : parsed.items);
      setNextCursor(parsed.nextCursor);
    } catch (cause) { if (requestId === listRequest.current) setError(cause instanceof Error ? cause.message : "公共规则草稿读取失败"); }
    finally { if (requestId === listRequest.current) setLoading(false); }
  };
  useEffect(() => { listRequest.current += 1; setItems([]); setNextCursor(undefined); setDetail(undefined); setLoading(false); void load(); }, [visible, platform]);

  if (!visible) return null;
  const openDetail = async (item: ReviewRule) => {
    setError(""); setDetail(undefined);
    try {
      const response = await rpc<unknown>("ops.rules.public.drafts.get", { platform: item.platform, pack_id: item.pack_id, version: item.version });
      const result = parsePublicRuleDraftDetail(response);
      if (result.rule.checksum !== item.checksum || result.rule.id !== item.id) throw new Error("规则列表与详情不一致，请刷新后重新选择");
      setDetail(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "公共规则详情读取失败"); }
  };
  const transition = async (status: "active" | "inactive") => {
    if (!detail || busy || !canWrite) return;
    if (status === "active" && (!canApprove || !canReviewPublicRuleDraft(authorization, detail.rule) || !approvalRef.trim() || !approvedBy.trim() || !approvedAt.trim() || !reason.trim() || !approvalToken.trim())) return;
    if (status === "inactive" && !reason.trim()) return;
    setBusy(true); setError("");
    try {
      // Re-read the immutable version immediately before transition so a stale
      // review tab cannot approve or reject a version another reviewer changed.
      const latestValue = await rpc<unknown>("ops.rules.public.drafts.get", { platform: detail.rule.platform, pack_id: detail.rule.pack_id, version: detail.rule.version });
      const latest = parsePublicRuleDraftDetail(latestValue).rule;
      if (latest.id !== detail.rule.id || latest.revision !== detail.rule.revision || latest.checksum !== detail.rule.checksum || latest.status !== "draft") {
        throw new Error("草稿已被其他审核员更新；请刷新列表后重新核对最新版本");
      }
      if (status === "active" && !latest.checksum_valid) throw new Error("规则校验和未通过，禁止激活");
      await rpc("rule.status", buildPublicRuleStatusParams(detail.rule, status, reason.trim(), status === "active" ? {
        approvalRef: approvalRef.trim(), approvedBy: approvedBy.trim(), approvedAt: approvedAt.trim(),
      } : undefined), status === "active" ? { ruleApprovalToken: approvalToken.trim() } : {});
      message.success(status === "active" ? "公共规则已审批并激活" : "公共规则草稿已拒绝并归档");
      setDetail(undefined); setReason(""); setApprovalRef(""); setApprovedBy(""); setApprovedAt(""); setApprovalToken("");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "公共规则状态更新失败"); }
    finally { setBusy(false); }
  };

  return <Card title="公共平台规则草稿审核" extra={<Typography.Text type="secondary">平台工作台 · 仅展示待审核公共草稿</Typography.Text>}>
    <Alert type="warning" showIcon title="审核会影响所有商家" description="激活前请核对官方依据、规则内容和校验和。人工审批仅记录运营审核，不代表系统独立验证来源网站。" style={{ marginBottom: 16 }} />
    {!canWrite && <Alert type="info" showIcon title="只读审核视图" description="当前身份只有规则读取权限；审批、激活或拒绝需要 rule.update，激活还需要 rule.publish.approve 和服务端签发的规则审批凭证。" style={{ marginBottom: 16 }} />}
    <Space wrap style={{ marginBottom: 12 }}><Select aria-label="按平台筛选公共规则草稿" allowClear placeholder="全部平台" value={platform || undefined} onChange={value => setPlatform((value ?? "") as Platform | "")} options={platforms.map(value => ({ value, label: platformLabels[value] }))} style={{ minWidth: 180 }} /><Button onClick={() => void load()} loading={loading}>刷新草稿</Button></Space>
    {error && <Alert type="error" showIcon title="公共规则审核操作失败" description={error} style={{ marginBottom: 12 }} />}
    {items.length ? <Table rowKey="id" size="small" dataSource={items} columns={columns} pagination={false} scroll={{ x: 900 }} onRow={item => ({ onClick: () => void openDetail(item), style: { cursor: "pointer" } })} /> : !loading ? <Empty description="当前筛选范围内没有待审核公共规则草稿" /> : null}
    {nextCursor && <Button style={{ marginTop: 12 }} loading={loading} onClick={() => void load(nextCursor)}>加载更多</Button>}
    {detail && <Card size="small" title={`${detail.rule.name} · ${detail.rule.version}`} style={{ marginTop: 16 }}>
      <Descriptions size="small" column={2} items={[
        { key: "platform", label: "平台", children: platformLabels[detail.rule.platform] ?? detail.rule.platform }, { key: "creator", label: "提交人", children: detail.rule.created_by },
        { key: "source", label: "依据来源", children: <Typography.Text copyable>{detail.rule.source.reference}</Typography.Text> }, { key: "source-trust", label: "来源状态", children: detail.rule.source.trust },
        { key: "checksum", label: "SHA-256", children: <Typography.Text code copyable>{detail.rule.checksum}</Typography.Text> }, { key: "integrity", label: "校验结果", children: detail.rule.checksum_valid ? "通过" : "失败，禁止激活" },
        { key: "checks", label: "规则内容", span: 2, children: <Typography.Paragraph copyable={{ text: JSON.stringify(detail.rule.checks ?? {}, null, 2) }} style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(detail.rule.checks ?? {}, null, 2)}</Typography.Paragraph> },
        { key: "audit", label: "审核历史", span: 2, children: detail.audit.length ? detail.audit.map(event => `${new Date(event.occurred_at).toLocaleString()} · ${event.action} · ${event.actor_id}${event.reason ? ` · ${event.reason}` : ""}`).join("\n") : "暂无审核事件" },
      ]} />
      {canWrite && <Space direction="vertical" style={{ width: "100%" }}>
        <Input aria-label="审核原因" placeholder="审核原因（必填）" value={reason} onChange={event => setReason(event.target.value)} />
        {canApprove && <><Input aria-label="审批凭证编号" placeholder="审批凭证编号" value={approvalRef} onChange={event => setApprovalRef(event.target.value)} /><Input aria-label="独立审批人" placeholder="独立审批人" value={approvedBy} onChange={event => setApprovedBy(event.target.value)} /><Input aria-label="审批时间" placeholder="审批时间 ISO 8601" value={approvedAt} onChange={event => setApprovedAt(event.target.value)} /><Input.Password aria-label="规则审批凭证" placeholder="服务端签发的规则审批凭证" value={approvalToken} onChange={event => setApprovalToken(event.target.value)} /></>}
        <Space><Button danger disabled={!reason.trim() || detail.rule.status !== "draft"} loading={busy} onClick={() => void transition("inactive")}>拒绝并归档</Button>{canApprove && <Button type="primary" disabled={!reason.trim() || !approvalRef.trim() || !approvedBy.trim() || !approvedAt.trim() || !approvalToken.trim() || !canReviewPublicRuleDraft(authorization, detail.rule)} loading={busy} onClick={() => void transition("active")}>审批并激活</Button>}</Space>
      </Space>}
    </Card>}
  </Card>;
}
