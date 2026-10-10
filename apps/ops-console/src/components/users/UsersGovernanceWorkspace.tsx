import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Alert, Button, Card, Drawer, Dropdown, Form, Input, Radio, Space, Table, Tag, Typography, message } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import { OpsPageError } from "../OpsPageError";
import { UserDirectorySection } from "./UserDirectorySection";
import { WorkspaceGovernanceSection } from "./WorkspaceGovernanceSection";
import { MembersSection } from "../finance/MembersSection";
import { AuthorizationGovernanceSection, canViewAuthorizationGovernance } from "./AuthorizationGovernanceSection";
import { opsRestGet, opsRestPost, describeOpsError } from "../../api/opsClient.js";

type Registration = { application_id: string; login: string; enterprise_name: string | null; contact_name: string | null; status: string; workspace_ids: string[]; created_at: string; updated_at: string; revision: number };

export function RegistrationApplications({ model }: { model: OpsConsoleModel }) {
  const session = model.opsSession;
  const sessionBoundary = JSON.stringify([
    session?.actor_id, session?.identity_id, session?.session_id,
    session?.context_id, session?.context_version, session?.workspace_id,
    session?.workbench, session?.scope, session?.roles, session?.capabilities,
    model.authorization.can("identity.read"),
  ]);
  return <RegistrationApplicationsForSession key={sessionBoundary} model={model} />;
}

function RegistrationApplicationsForSession({ model }: { model: OpsConsoleModel }) {
  const pageSize = 20;
  const [items, setItems] = useState<Registration[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [reviewError, setReviewError] = useState("");
  const [target, setTarget] = useState<Registration>();
  const [reason, setReason] = useState("");
  const [decision, setDecision] = useState<"undecided" | "approved" | "rejected">("undecided");
  // A failed read must stay distinguishable from an empty directory: the toast
  // disappears after a few seconds, and `dataSource={[]}` alone renders the
  // table's own "暂无数据" placeholder, which reads as "no applications".
  const load = async (nextOffset = offset) => {
    setLoading(true);
    try {
      const result = await opsRestGet<{ items: Registration[]; total: number; limit: number; offset: number }>(`/v1/ops/merchant-registration-applications?limit=${pageSize}&offset=${nextOffset}`);
      setItems(result?.items ?? []);
      setTotal(result?.total ?? 0);
      setOffset(result?.offset ?? nextOffset);
      setLoadError("");
    } catch (error) {
      const failure = describeOpsError(error);
      setLoadError(failure);
      message.error(failure);
    } finally {
      setLoading(false);
    }
  };
  const hasOpsRegistrationRole = model.authorization.roles.some(role => ["platform_ops", "platform_admin", "ops_admin"].includes(role));
  const canRead = hasOpsRegistrationRole && model.authorization.can("identity.read");
  const canUpdate = canRead && model.authorization.can("identity.update");
  useEffect(() => { if (canRead) void load(0); }, [canRead]);
  if (!canRead) return <></>;
  const submit = async () => {
    if (!target || decision !== "rejected" || reason.trim().length < 4) return;
    setLoading(true);
    setReviewError("");
    try {
      await opsRestPost("/v1/ops/merchant-registration-applications/review", {
        login: target.login,
        decision,
        reason: reason.trim(),
        workspace_ids: [],
      });
      message.success("注册申请已拒绝");
      setTarget(undefined);
      setReason("");
      setReviewError("");
      await load();
      await model.loadUsers({ page: 1 });
    } catch (error) {
      const failure = describeOpsError(error);
      setReviewError(`审核未完成：${failure}`);
      message.error(failure);
    } finally {
      setLoading(false);
    }
  };

  const columns = [
    { title: "申请编号", dataIndex: "application_id", render: (value: string) => <Typography.Text copyable>{value}</Typography.Text> },
    { title: "登录邮箱", dataIndex: "login" },
    { title: "企业名称", dataIndex: "enterprise_name" },
    { title: "联系人", dataIndex: "contact_name" },
    { title: "状态", dataIndex: "status", render: (value: string) => <Tag color={value === "merchant_pending" ? "gold" : value === "active" ? "green" : "red"}>{value === "merchant_pending" ? "待审核" : value === "active" ? "已通过" : "已拒绝"}</Tag> },
    {
      title: "操作",
      render: (_: unknown, row: Registration) => row.status === "merchant_pending"
        ? canUpdate ? <Button disabled={Boolean(loadError) || loading} onClick={() => {
          setTarget(row);
          setReviewError("");
          setReason("");
          setDecision("undecided");
        }}>审核</Button> : <Typography.Text type="secondary">只读</Typography.Text>
        : <Typography.Text type="secondary">已处理</Typography.Text>,
    },
  ];

  return (
    <Card title="入驻申请" extra={<Button onClick={() => void load()} loading={loading}>刷新申请</Button>} style={{ marginBottom: 16 }}>
      <Alert type="info" showIcon title="入驻申请与已入驻用户不是两套账号" description="通过审批当前暂不可用；拒绝申请仍可在这里完成。" style={{ marginBottom: 16 }} />
      {!canUpdate && <Alert type="info" showIcon title="当前为只读视图" description="可以查看入驻申请；拒绝申请需要 identity.update 权限。" style={{ marginBottom: 16 }} />}
      <OpsPageError error={loadError} onRetry={() => void load()} />
      {loadError && items.length > 0 && <Typography.Text role="status" type="warning">当前申请列表读取失败，显示的是上次读取结果；审核操作已暂停，请先重新读取。</Typography.Text>}
      <Table
        rowKey="application_id"
        loading={loading}
        dataSource={items}
        locale={{ emptyText: loadError ? "入驻申请读取失败，这不是空表：请查看上方错误摘要后重试，不要把没有读到的申请当成没有申请。" : "暂无入驻申请" }}
        pagination={{ current: Math.floor(offset / pageSize) + 1, pageSize, total, showSizeChanger: false, showTotal: value => `共 ${value} 条` }}
        onChange={pagination => void load(((pagination.current ?? 1) - 1) * pageSize)}
        columns={columns}
      />
      <Drawer
        title={target ? `审核入驻申请 · ${target.enterprise_name ?? target.login}` : "审核入驻申请"}
        open={Boolean(target)}
        onClose={() => { if (!loading) setTarget(undefined); }}
        closable={!loading}
        keyboard={!loading}
        maskClosable={!loading}
        size={460}
        extra={<Button type="primary" loading={loading} disabled={decision !== "rejected" || reason.trim().length < 4} onClick={() => void submit()}>提交审核</Button>}
      >
        <Form layout="vertical">
          <Form.Item label="审核决定">
            <Radio.Group aria-label="审核决定" value={decision} onChange={event => setDecision(event.target.value)}>
              <Space orientation="vertical">
                <Radio value="approved" disabled>通过（暂不可用）</Radio>
                <Radio value="rejected">拒绝</Radio>
              </Space>
            </Radio.Group>
          </Form.Item>
          <Alert
            type="warning"
            showIcon
            title="通过审批暂不可用"
            description="旧授权接口返回 HTTP 410。通过审批需先接通商业订单创建、收款核验和成员绑定流程；当前页面尚未完成这项流程，因此通过不可用。拒绝申请仍可处理。"
            style={{ marginBottom: 16 }}
          />
          {reviewError && <Alert type="error" showIcon title="申请审核未完成" description={reviewError} style={{ marginBottom: 16 }} />}
          <Form.Item label="审核原因" required>
            <Input.TextArea aria-label="审核原因" value={reason} onChange={event => setReason(event.target.value)} minLength={4} rows={4} placeholder="至少填写 4 个字符" />
          </Form.Item>
        </Form>
      </Drawer>
    </Card>
  );
}

export type UsersGovernanceSectionKey = "directory" | "workspaces" | "members" | "registrations" | "authorization";

export function PlatformMembersUnavailable() {
  return <Alert showIcon type="info" title="请先进入商家工作区" description="成员列表和邀请操作只在已授权的商家工作区会话中可用。当前是平台全局会话，无法读取或修改某个工作区的成员。" />;
}

type CapabilityReader = Pick<OpsConsoleModel["authorization"], "can" | "roles" | "scope">;

export function visibleUsersGovernanceSections(authorization: CapabilityReader, accountLogin?: string | null): UsersGovernanceSectionKey[] {
  const sections: UsersGovernanceSectionKey[] = [];
  if (authorization.can("identity.read")) sections.push("directory");
  if (authorization.can("workspace.directory.read")) sections.push("workspaces");
  if (authorization.can("workspace.member.read")) sections.push("members");
  if (canViewAuthorizationGovernance(authorization, accountLogin)) sections.push("authorization");
  // Listing and reviewing are separate capabilities: read-only operators can
  // inspect applications, while the component hides review actions without
  // identity.update. Update-only access cannot load the list and stays hidden.
  if (authorization.roles.some(role => ["platform_ops", "platform_admin", "ops_admin"].includes(role))
    && authorization.can("identity.read")) sections.push("registrations");
  return sections;
}

export function UsersGovernanceWorkspace({ model, onRefresh }: { model: OpsConsoleModel; onRefresh?: () => void }) {
  const sectionKeys = useMemo(() => visibleUsersGovernanceSections(model.authorization, model.opsSession?.account_login), [model.authorization, model.opsSession?.account_login]);
  const unavailableRef = useRef<HTMLDivElement>(null);
  const [activeSection, setActiveSection] = useState<string>(sectionKeys[0] ?? "directory");

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
      role="group"
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
  if (sectionKeys.includes("directory")) tabs.push({ key: "directory", label: "已接入用户", children: <section id="user-directory" className="ops-users-section" aria-labelledby="user-directory-heading"><OpsPageError error={model.userDirectoryError} onRetry={() => void model.loadUsers()} /><UserDirectorySection model={model} /></section> });
  if (sectionKeys.includes("workspaces")) tabs.push({ key: "workspaces", label: "商家工作区", children: <section id="workspace-governance" className="ops-users-section"><WorkspaceGovernanceSection model={model} /></section> });
  if (sectionKeys.includes("members")) tabs.push({ key: "members", label: "成员", children: <section id="member-governance" className="ops-users-section">{model.opsSession?.workspace_id
    ? <MembersSection model={model} />
    : <PlatformMembersUnavailable />}</section> });
  if (sectionKeys.includes("registrations")) tabs.push({ key: "registrations", label: "入驻申请", children: <section className="ops-users-section"><RegistrationApplications model={model} /></section> });
  if (sectionKeys.includes("authorization")) tabs.push({ key: "authorization", label: "权限与授权", children: <section id="authorization-governance" className="ops-users-section"><AuthorizationGovernanceSection model={model} /></section> });

  const currentSection = tabs.find((tab) => tab.key === activeSection) ?? tabs[0]!;
  const otherSections = tabs.filter((tab) => tab.key !== activeSection);
  const selectSection = (key: string) => setActiveSection(key);
  if (currentSection.key === "directory") {
    const directory = <section id="user-directory" className="ops-users-section" aria-labelledby="user-directory-heading">
      <OpsPageError error={model.userDirectoryError} onRetry={() => void model.loadUsers()} />
      <UserDirectorySection model={model} governanceSections={otherSections.map(({ key, label }) => ({ key, label }))} onSelectGovernanceSection={selectSection} />
    </section>;
    return <div className="ops-users-workspace" aria-label="用户治理工作区">{directory}</div>;
  }

  const menuItems = otherSections.map(({ key, label }) => ({ key, label }));
  return (
    <div className="ops-users-workspace" aria-label="用户治理工作区">
      <div className="ops-users-secondary-navigation">
        {menuItems.length > 0 ? <Dropdown menu={{ items: menuItems, onClick: ({ key }) => selectSection(key) }}>
          <Button aria-label={`切换用户治理页面；当前为${currentSection.label}；其他页面：${otherSections.map(({ label }) => label).join("、")}`}>更多治理</Button>
        </Dropdown> : <Typography.Text strong>{currentSection.label}</Typography.Text>}
      </div>
      {currentSection.children}
    </div>
  );
}
