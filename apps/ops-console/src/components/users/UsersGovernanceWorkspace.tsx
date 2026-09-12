import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Card, Drawer, Form, Input, Select, Space, Table, Tag, Typography, message } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import { OpsPageError } from "../OpsPageError";
import { AuthorizationGovernanceSection } from "./AuthorizationGovernanceSection";
import { UserDirectorySection } from "./UserDirectorySection";
import { WorkspaceGovernanceSection } from "./WorkspaceGovernanceSection";
import { MembersSection } from "../finance/MembersSection";
import { opsRestGet, opsRestPost, describeOpsError } from "../../api/opsClient.js";

type Registration = { application_id: string; login: string; enterprise_name: string | null; contact_name: string | null; status: string; workspace_ids: string[]; created_at: string; updated_at: string; revision: number };

function RegistrationApplications({ model }: { model: OpsConsoleModel }) {
  const [items, setItems] = useState<Registration[]>([]); const [loading, setLoading] = useState(false); const [target, setTarget] = useState<Registration>(); const [reason, setReason] = useState(""); const [decision, setDecision] = useState<"approved" | "rejected">("approved"); const [workspaceIds, setWorkspaceIds] = useState(""); const [memberRole, setMemberRole] = useState<"merchant_admin" | "operator" | "support" | "finance">("merchant_admin"); const [skuCode, setSkuCode] = useState("sku-onboarding-once"); const [amountFen, setAmountFen] = useState("500000");
  const load = async () => { setLoading(true); try { const result = await opsRestGet<{ items: Registration[] }>("/v1/ops/merchant-registration-applications"); setItems(result?.items ?? []); } catch (e) { message.error(describeOpsError(e)); } finally { setLoading(false); } };
  const canRead = model.authorization.can("identity.read");
  useEffect(() => { if (canRead) void load(); }, [canRead]);
  if (!canRead) return null;
  const submit = async () => { if (!target || reason.trim().length < 4 || (decision === "approved" && (!workspaceIds.trim() || !skuCode.trim()))) return; setLoading(true); try { const selectedWorkspaces = workspaceIds.split(/[\s,，]+/u).filter(Boolean); if (decision === "approved") { for (const workspaceId of selectedWorkspaces) { const authorization = await model.authorizeMerchantAccount({ login: target.login, workspaceId, memberRole, skuCode, amountFen: Number(amountFen), paymentStatus: "pending", reason: reason.trim(), idempotencyKey: `registration-authorize-${target.application_id}-${workspaceId}` }); if (!authorization) throw new Error(`工作区 ${workspaceId} 的角色和套餐绑定未完成`); } } await opsRestPost("/v1/ops/merchant-registration-applications/review", { login: target.login, decision, reason: reason.trim(), workspace_ids: selectedWorkspaces }); message.success(decision === "approved" ? "注册已通过，工作区角色和套餐已绑定，等待收款核验" : "注册申请已拒绝"); setTarget(undefined); setReason(""); await load(); await model.loadUsers({ page: 1 }); } catch (e) { message.error(describeOpsError(e)); } finally { setLoading(false); } };
  return <Card title="注册申请" extra={<Button onClick={() => void load()} loading={loading}>刷新申请</Button>} style={{ marginBottom: 16 }}><Table rowKey="application_id" loading={loading} dataSource={items} pagination={{ pageSize: 10 }} columns={[{ title: "申请编号", dataIndex: "application_id", render: (v: string) => <Typography.Text copyable>{v}</Typography.Text> }, { title: "登录邮箱", dataIndex: "login" }, { title: "企业名称", dataIndex: "enterprise_name" }, { title: "联系人", dataIndex: "contact_name" }, { title: "状态", dataIndex: "status", render: (v: string) => <Tag color={v === "merchant_pending" ? "gold" : v === "active" ? "green" : "red"}>{v === "merchant_pending" ? "待审核" : v === "active" ? "已通过" : "已拒绝"}</Tag> }, { title: "操作", render: (_: unknown, row: Registration) => row.status === "merchant_pending" ? <Button onClick={() => { setTarget(row); setDecision("approved"); setWorkspaceIds(""); setMemberRole("merchant_admin"); setSkuCode("sku-onboarding-once"); setAmountFen("500000"); }}>审核</Button> : <Typography.Text type="secondary">已处理</Typography.Text> }]} /><Drawer title={target ? `审核注册申请 · ${target.enterprise_name ?? target.login}` : "审核注册申请"} open={Boolean(target)} onClose={() => setTarget(undefined)} size={460} extra={<Button type="primary" loading={loading} disabled={reason.trim().length < 4 || (decision === "approved" && (!workspaceIds.trim() || !skuCode.trim()))} onClick={() => void submit()}>提交审核</Button>}><Form layout="vertical"><Form.Item label="审核决定"><Select value={decision} onChange={setDecision} options={[{ value: "approved", label: "通过" }, { value: "rejected", label: "拒绝" }]} /></Form.Item>{decision === "approved" && <><Form.Item label="绑定企业工作区" required><Input value={workspaceIds} onChange={e => setWorkspaceIds(e.target.value)} placeholder="workspace_id（可填多个，以空格分隔）" /></Form.Item><Form.Item label="工作区角色" required><Select value={memberRole} onChange={setMemberRole} options={[{ value: "merchant_admin", label: "企业管理员" }, { value: "operator", label: "运营" }, { value: "support", label: "支持" }, { value: "finance", label: "财务" }]} /></Form.Item><Form.Item label="套餐 SKU" required><Select value={skuCode} onChange={(value) => { setSkuCode(value); setAmountFen(value === "sku-monthly-2000" ? "200000" : value === "sku-monthly-5000" ? "500000" : value === "sku-monthly-10000" ? "1000000" : "500000"); }} options={[{ value: "sku-onboarding-once", label: "系统接入服务 · ¥5,000" }, { value: "sku-monthly-2000", label: "基础版 · ¥2,000" }, { value: "sku-monthly-5000", label: "成长版 · ¥5,000" }, { value: "sku-monthly-10000", label: "定制版起 · ¥10,000" }]} /></Form.Item><Form.Item label="套餐金额（分）" required><Input value={amountFen} onChange={e => setAmountFen(e.target.value)} inputMode="numeric" /></Form.Item><Alert type="info" showIcon title="审核通过后立即绑定工作区角色和套餐，但收款状态保持待核验，不开放已付权益。" /></>}<Form.Item label="审核原因" required><Input.TextArea value={reason} onChange={e => setReason(e.target.value)} minLength={4} rows={4} placeholder="至少填写 4 个字符" /></Form.Item></Form></Drawer></Card>;
}

export type UsersGovernanceSectionKey = "directory" | "workspaces" | "authorization" | "members";

type CapabilityReader = Pick<OpsConsoleModel["authorization"], "can">;

export function visibleUsersGovernanceSections(authorization: CapabilityReader): UsersGovernanceSectionKey[] {
  const sections: UsersGovernanceSectionKey[] = [];
  if (authorization.can("identity.read")) sections.push("directory");
  if (authorization.can("workspace.directory.read")) sections.push("workspaces");
  if (authorization.can("authorization.role.read") || authorization.can("authorization.grant.read")) sections.push("authorization");
  if (authorization.can("workspace.member.read")) sections.push("members");
  return sections;
}

export function UsersGovernanceWorkspace({ model, onRefresh }: { model: OpsConsoleModel; onRefresh?: () => void }) {
  const sectionKeys = useMemo(() => visibleUsersGovernanceSections(model.authorization), [model.authorization]);
  const unavailableRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sectionKeys.length) unavailableRef.current?.focus({ preventScroll: true });
  }, [sectionKeys.length]);

  useEffect(() => {
    if (!model.authorizationTargetWorkspaceId?.trim() || !sectionKeys.includes("authorization")) return;
    document.getElementById("authorization-governance")?.scrollIntoView({ block: "start" });
  }, [model.authorizationTargetWorkspaceId, sectionKeys]);

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

  return (
    <div className="ops-users-workspace" aria-label="用户治理工作区">
      <RegistrationApplications model={model} />
      <div className="ops-users-sections">
        {sectionKeys.includes("directory") && (
          <section id="user-directory" className="ops-users-section" aria-labelledby="user-directory-heading">
            <div className="ops-users-section-heading">
              <div>
                <Typography.Text className="ops-users-section-kicker">IDENTITY DIRECTORY</Typography.Text>
                <Typography.Title id="user-directory-heading" level={4}>用户目录</Typography.Title>
                <Typography.Text type="secondary">查询用户身份、成员关系、角色、企业主体和商业快照。</Typography.Text>
              </div>
            </div>
            <OpsPageError error={model.userDirectoryError} onRetry={() => void model.loadUsers()} />
            <UserDirectorySection model={model} />
          </section>
        )}

        {sectionKeys.includes("workspaces") && (
          <section id="workspace-governance" className="ops-users-section" aria-labelledby="workspace-governance-heading">
            <div className="ops-users-section-heading">
              <div>
                <Typography.Text className="ops-users-section-kicker">ENTERPRISE GOVERNANCE</Typography.Text>
                <Typography.Title id="workspace-governance-heading" level={4}>企业主体治理</Typography.Title>
                <Typography.Text type="secondary">管理企业主体状态和平台级访问边界。</Typography.Text>
              </div>
            </div>
            <WorkspaceGovernanceSection model={model} />
          </section>
        )}

        {sectionKeys.includes("members") && (
          <section id="member-governance" className="ops-users-section" aria-labelledby="member-governance-heading">
            <div className="ops-users-section-heading">
              <div>
                <Typography.Text className="ops-users-section-kicker">MEMBER GOVERNANCE</Typography.Text>
                <Typography.Title id="member-governance-heading" level={4}>成员管理</Typography.Title>
                <Typography.Text type="secondary">为指定企业主体邀请成员并维护企业角色。</Typography.Text>
              </div>
            </div>
            <MembersSection model={model} />
          </section>
        )}

        {sectionKeys.includes("authorization") && (
          <section id="authorization-governance" className="ops-users-section" aria-labelledby="authorization-governance-heading">
            <div className="ops-users-section-heading">
              <div>
                <Typography.Text className="ops-users-section-kicker">AUTHORIZATION CENTER</Typography.Text>
                <Typography.Title id="authorization-governance-heading" level={4}>权限与授权</Typography.Title>
                <Typography.Text type="secondary">查看功能权限矩阵、平台角色和精确范围的临时授权。</Typography.Text>
              </div>
            </div>
            <AuthorizationGovernanceSection model={model} />
          </section>
        )}
      </div>
    </div>
  );
}
