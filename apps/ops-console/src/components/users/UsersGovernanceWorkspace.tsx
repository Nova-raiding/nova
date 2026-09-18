import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Alert, Button, Card, Drawer, Form, Input, Select, Space, Table, Tabs, Tag, Typography, message } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import { OpsPageError } from "../OpsPageError";
import { UserDirectorySection } from "./UserDirectorySection";
import { WorkspaceGovernanceSection } from "./WorkspaceGovernanceSection";
import { MembersSection } from "../finance/MembersSection";
import { opsRestGet, opsRestPost, describeOpsError } from "../../api/opsClient.js";
import { packageDisplayName } from "../commercial/packageLabels.js";
import { provisionableCatalogItems } from "../../api/commercialOperationsClient.js";
import { yuanToFen } from "../../utils/currency.js";

type Registration = { application_id: string; login: string; enterprise_name: string | null; contact_name: string | null; status: string; workspace_ids: string[]; created_at: string; updated_at: string; revision: number };

function RegistrationApplications({ model }: { model: OpsConsoleModel }) {
  const [items, setItems] = useState<Registration[]>([]);
  const [loading, setLoading] = useState(false);
  const [target, setTarget] = useState<Registration>();
  const [reason, setReason] = useState("");
  const [decision, setDecision] = useState<"approved" | "rejected">("approved");
  const [workspaceIds, setWorkspaceIds] = useState("");
  const [memberRole, setMemberRole] = useState<"merchant_admin" | "operator" | "support" | "finance">("merchant_admin");
  const [skuCode, setSkuCode] = useState("");
  const [amountYuan, setAmountYuan] = useState("");
  const catalog = useMemo(() => provisionableCatalogItems(model.platformCommercialCatalog ?? []), [model.platformCommercialCatalog]);
  const catalogBySku = useMemo(() => new Map(catalog.map((item) => [item.skuCode, item])), [catalog]);
  const load = async () => { setLoading(true); try { const result = await opsRestGet<{ items: Registration[] }>("/v1/ops/merchant-registration-applications"); setItems(result?.items ?? []); } catch (e) { message.error(describeOpsError(e)); } finally { setLoading(false); } };
  const canRead = model.authorization.can("identity.read");
  useEffect(() => { if (canRead) void load(); }, [canRead]);
  if (!canRead) return <></>;
  const submit = async () => {
    if (!target || reason.trim().length < 4 || (decision === "approved" && (!workspaceIds.trim() || !skuCode.trim()))) return;
    setLoading(true);
    try {
      const selectedWorkspaces = workspaceIds.split(/[\s,，]+/u).filter(Boolean);
      if (decision === "approved") {
        for (const workspaceId of selectedWorkspaces) {
          const authorization = await model.authorizeMerchantAccount({ login: target.login, workspaceId, memberRole, skuCode, amountFen: yuanToFen(amountYuan), paymentStatus: "pending", reason: reason.trim(), idempotencyKey: `registration-authorize-${target.application_id}-${workspaceId}` });
          if (!authorization) throw new Error(`工作区 ${workspaceId} 的角色和套餐绑定未完成`);
        }
      }
      await opsRestPost("/v1/ops/merchant-registration-applications/review", { login: target.login, decision, reason: reason.trim(), workspace_ids: selectedWorkspaces });
      message.success(decision === "approved" ? "开通已通过，工作区角色和套餐已绑定，等待收款核验" : "开通申请已拒绝");
      setTarget(undefined); setReason(""); await load(); await model.loadUsers({ page: 1 });
    } catch (e) { message.error(describeOpsError(e)); } finally { setLoading(false); }
  };
  return <Card title="商家账号开通记录" extra={<Button onClick={() => void load()} loading={loading}>刷新记录</Button>} style={{ marginBottom: 16 }}>
    <Alert type="info" showIcon title="商家账号统一由平台运营创建" description="商家不能自行注册。平台运营在“已开通用户 → 开通商家账号”中创建账号并绑定企业工作区；这里仅保留历史待处理记录。" style={{ marginBottom: 16 }} />
    <Table rowKey="application_id" loading={loading} dataSource={items} pagination={{ pageSize: 10 }} columns={[{ title: "申请编号", dataIndex: "application_id", render: (v: string) => <Typography.Text copyable>{v}</Typography.Text> }, { title: "登录邮箱", dataIndex: "login" }, { title: "企业名称", dataIndex: "enterprise_name" }, { title: "联系人", dataIndex: "contact_name" }, { title: "状态", dataIndex: "status", render: (v: string) => <Tag color={v === "merchant_pending" ? "gold" : v === "active" ? "green" : "red"}>{v === "merchant_pending" ? "待审核" : v === "active" ? "已通过" : "已拒绝"}</Tag> }, { title: "操作", render: (_: unknown, row: Registration) => row.status === "merchant_pending" ? <Button disabled={!catalog.length} onClick={() => { const first = catalog[0]; setTarget(row); setDecision("approved"); setWorkspaceIds(""); setMemberRole("merchant_admin"); setSkuCode(first?.skuCode ?? ""); setAmountYuan(first?.priceFen === null || first?.priceFen === undefined ? "" : (first.priceFen / 100).toFixed(2)); }}>审核</Button> : <Typography.Text type="secondary">已处理</Typography.Text> }]} />
    {!catalog.length ? <Alert type="warning" showIcon title="暂无可执行套餐" description="服务端尚未返回公开、已审批、可执行且已定价的商业 SKU；账号开通保持阻断。" style={{ marginTop: 12 }} /> : null}
    <Drawer title={target ? `审核开通申请 · ${target.enterprise_name ?? target.login}` : "审核开通申请"} open={Boolean(target)} onClose={() => setTarget(undefined)} size={460} extra={<Button type="primary" loading={loading} disabled={reason.trim().length < 4 || (decision === "approved" && (!workspaceIds.trim() || !skuCode.trim()))} onClick={() => void submit()}>提交审核</Button>}>
      <Form layout="vertical"><Form.Item label="审核决定"><Select value={decision} onChange={setDecision} options={[{ value: "approved", label: "通过" }, { value: "rejected", label: "拒绝" }]} /></Form.Item>
        {decision === "approved" && <><Form.Item label="绑定企业工作区" required><Input value={workspaceIds} onChange={e => setWorkspaceIds(e.target.value)} placeholder="workspace_id（可填多个，以空格分隔）" /></Form.Item><Form.Item label="工作区角色" required><Select value={memberRole} onChange={setMemberRole} options={[{ value: "merchant_admin", label: "企业管理员" }, { value: "operator", label: "运营" }, { value: "support", label: "支持" }, { value: "finance", label: "财务" }]} /></Form.Item><Form.Item label="套餐" required><Select value={skuCode || undefined} disabled={!catalog.length} onChange={(value) => { const item = catalogBySku.get(value); setSkuCode(value); setAmountYuan(item?.priceFen === null || item?.priceFen === undefined ? "" : (item.priceFen / 100).toFixed(2)); }} options={catalog.map((item) => ({ value: item.skuCode, label: `${packageDisplayName(item.skuCode, item.name)} · ${item.priceLabel}` }))} /></Form.Item><Form.Item label="套餐金额（元）" extra="价格来自服务端已发布 SKU" required><Input value={amountYuan} readOnly inputMode="decimal" /></Form.Item><Alert type="info" showIcon title="审核通过后立即绑定工作区角色和套餐，但收款状态保持待核验，不开放已付权益。" /></>}
        <Form.Item label="审核原因" required><Input.TextArea value={reason} onChange={e => setReason(e.target.value)} minLength={4} rows={4} placeholder="至少填写 4 个字符" /></Form.Item>
      </Form>
    </Drawer>
  </Card>;
}

export type UsersGovernanceSectionKey = "directory" | "workspaces" | "members";

type CapabilityReader = Pick<OpsConsoleModel["authorization"], "can">;

export function visibleUsersGovernanceSections(authorization: CapabilityReader): UsersGovernanceSectionKey[] {
  const sections: UsersGovernanceSectionKey[] = [];
  if (authorization.can("identity.read")) sections.push("directory");
  if (authorization.can("workspace.directory.read")) sections.push("workspaces");
  if (authorization.can("workspace.member.read")) sections.push("members");
  return sections;
}

export function UsersGovernanceWorkspace({ model, onRefresh }: { model: OpsConsoleModel; onRefresh?: () => void }) {
  const sectionKeys = useMemo(() => visibleUsersGovernanceSections(model.authorization), [model.authorization]);
  const unavailableRef = useRef<HTMLDivElement>(null);
  const [activeSection, setActiveSection] = useState("directory");

  useEffect(() => {
    if (!sectionKeys.length) unavailableRef.current?.focus({ preventScroll: true });
  }, [sectionKeys.length]);

  useEffect(() => {
    if (sectionKeys.length && !sectionKeys.includes(activeSection as UsersGovernanceSectionKey)) setActiveSection(sectionKeys[0]);
  }, [activeSection, sectionKeys]);

  if (!sectionKeys.length) {
    return <div
      ref={unavailableRef}
      className="ops-users-governance-unavailable"
      tabIndex={-1}
      role="alert"
      aria-live="assertive"
      aria-labelledby="users-governance-unavailable-title"
    >
      <Alert
        showIcon
        type="warning"
        title={<span id="users-governance-unavailable-title">当前角色没有用户治理视图</span>}
        description="需要身份目录、企业主体目录或平台授权中心的读取能力。权限由服务端策略决定，不会把未授权结果显示为空数据。"
        action={onRefresh ? <Button size="small" style={{ minHeight: 44 }} aria-label="刷新用户治理权限" onClick={onRefresh}>刷新权限</Button> : undefined}
      />
    </div>;
  }

  const tabs: Array<{ key: string; label: string; children: ReactElement }> = [];
  if (sectionKeys.includes("directory")) tabs.push({ key: "directory", label: "已开通用户", children: <section id="user-directory" className="ops-users-section" aria-labelledby="user-directory-heading"><OpsPageError error={model.userDirectoryError} onRetry={() => void model.loadUsers()} /><UserDirectorySection model={model} /></section> });
  if (sectionKeys.includes("workspaces")) tabs.push({ key: "workspaces", label: "企业主体", children: <section id="workspace-governance" className="ops-users-section"><WorkspaceGovernanceSection model={model} /></section> });
  if (sectionKeys.includes("members")) tabs.push({ key: "members", label: "成员管理", children: <section id="member-governance" className="ops-users-section"><MembersSection model={model} /></section> });
  // 商家账号统一由“已开通用户 → 开通商家账号”创建；不再展示独立的开通申请入口，避免与用户目录形成两套入口。

  return (
    <div className="ops-users-workspace" aria-label="用户治理工作区">
      <div className="ops-users-quick-summary">
        <div><Typography.Text type="secondary">用户身份</Typography.Text><Typography.Title level={4}>{model.userDirectory.identityCount}</Typography.Title></div>
        <div><Typography.Text type="secondary">成员关系</Typography.Text><Typography.Title level={4}>{model.userDirectory.total}</Typography.Title></div>
        <div><Typography.Text type="secondary">企业主体</Typography.Text><Typography.Title level={4}>{model.userDirectory.workspaceCount}</Typography.Title></div>
        <Typography.Text type="secondary" className="ops-users-quick-summary-hint">选择下方任务查看详细治理信息</Typography.Text>
      </div>
      <Tabs
        className="ops-users-tabs"
        activeKey={activeSection}
        onChange={setActiveSection}
        items={tabs}
      />
    </div>
  );
}
