import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Card, Col, Divider, Form, Input, InputNumber, Row, Select, Space, Table, Tag, Typography } from "antd";
import { describeOpsError, rpc } from "../../api/opsClient";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import { DangerActionModal } from "../authz/DangerActionModal";
import { OpsPageError } from "../OpsPageError";
import { PermissionMatrixSection } from "./PermissionMatrixSection";

type RoleAssignment = { id: string; role: string; subjectIdentityId: string; expiresAt?: string; revision: number; authorizationRevision: number };
type Grant = { id: string; accessMode: "read" | "write"; workspaceId: string; capabilities: string[]; ticketRef: string; expiresAt: string; useCount: number; maxUses: number; revision: number; authorizationRevision: number };
type RoleList = { subject_identity_id: string; authorization_revision: number; assignments: RoleAssignment[] };
type GrantList = { subject_identity_id: string; workspace_id: string; authorization_revision: number; grants: Grant[] };
type PendingRevocation =
  | { kind: "role"; title: string; role: RoleAssignment; authorizationRevision: number }
  | { kind: "grant"; title: string; grant: Grant; subjectIdentityId: string; authorizationRevision: number };
type GrantStatus = { label: string; color: "green" | "gold" | "orange" | "red" };

const platformRoleLabels: Record<string, string> = {
  platform_admin: "平台管理员",
  ops_admin: "运营管理员",
  support_agent: "支持专员",
  finance_ops: "财务运营",
  security_admin: "安全管理员",
  auditor: "审计员",
  rules_admin: "规则管理员",
  model_admin: "模型管理员",
  release_admin: "发布管理员",
};
const accessModeLabels: Record<Grant["accessMode"], string> = { read: "只读", write: "可操作" };
const capabilityLabels: Record<string, string> = {
  "customer.content.read": "查看商品内容",
  "customer.content.update": "修改商品内容",
  "workspace.summary.read": "查看商家概览",
  "workspace.member.read": "查看商家成员",
  "workspace.member.manage": "管理商家成员",
};
const authorizationSuperAdminLogins = new Set(["hyp@sn.com", "hxd@sn.com", "devide@sn.com"]);

export function canViewAuthorizationGovernance(
  authorization: Pick<OpsConsoleModel["authorization"], "can" | "roles" | "scope">,
  accountLogin: string | null | undefined,
): boolean {
  return authorization.scope.kind === "platform"
    && authorizationSuperAdminLogins.has(accountLogin?.trim().toLowerCase() ?? "")
    && authorization.roles.some(role => role === "ops_admin" || role === "platform_admin")
    && (authorization.can("authorization.role.read") || authorization.can("authorization.grant.read"));
}

function readableCapability(value: string): string {
  return capabilityLabels[value] ?? value;
}

export function parseGrantCapabilities(value: unknown): string[] {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

export function describeGrantScope(workspaceId: string): string {
  const normalized = workspaceId.trim();
  return normalized ? `此 JIT 仅覆盖商家主体 ${normalized}，不会自动扩展到其他商家主体。` : "填写商家主体 ID 后，这里会显示精确授权范围。";
}

export function validateJitExpiry(value: unknown, accessMode: "read" | "write", now = Date.now()): string | undefined {
  const parsed = Date.parse(String(value ?? "").trim());
  if (!Number.isFinite(parsed)) return "请输入有效的 ISO 到期时间";
  if (parsed <= now) return "到期时间必须晚于当前时间";
  const maxTtl = accessMode === "write" ? 5 : 15;
  if (parsed > now + maxTtl * 60_000) return `${accessMode === "write" ? "写入" : "只读"} JIT 最长 ${maxTtl} 分钟`;
  return undefined;
}

export function describeGrantStatus(grant: Pick<Grant, "expiresAt" | "useCount" | "maxUses">, now = Date.now()): GrantStatus {
  if (grant.maxUses > 0 && grant.useCount >= grant.maxUses) return { label: "已用尽", color: "gold" };
  const expiresAt = Date.parse(grant.expiresAt);
  if (Number.isFinite(expiresAt)) {
    if (expiresAt <= now) return { label: "已过期", color: "red" };
    if (expiresAt - now <= 60_000) return { label: "即将到期", color: "orange" };
  }
  return { label: "有效", color: "green" };
}

export function AuthorizationGovernanceSection({ model }: { model: OpsConsoleModel }) {
  const { message } = App.useApp();
  const canReadRoles = model.authorization.can("authorization.role.read");
  const canManageRoles = model.authorization.can("authorization.role.manage");
  const canReadGrants = model.authorization.can("authorization.grant.read");
  const canManageGrants = model.authorization.can("authorization.grant.manage");
  const [subjectIdentityId, setSubjectIdentityId] = useState("");
  const [targetWorkspaceId, setTargetWorkspaceId] = useState("");
  const [roles, setRoles] = useState<RoleList>();
  const [rolesTarget, setRolesTarget] = useState<string>();
  const [assignableRoles, setAssignableRoles] = useState<string[]>([]);
  const [grants, setGrants] = useState<GrantList>();
  const [grantsTarget, setGrantsTarget] = useState<{ subjectIdentityId: string; workspaceId: string }>();
  const [roleLoadError, setRoleLoadError] = useState<unknown>();
  const [grantLoadError, setGrantLoadError] = useState<unknown>();
  const [roleLoading, setRoleLoading] = useState(false);
  const [grantLoading, setGrantLoading] = useState(false);
  const [roleSubmitting, setRoleSubmitting] = useState(false);
  const [roleSubmitError, setRoleSubmitError] = useState<unknown>();
  const [grantSubmitting, setGrantSubmitting] = useState(false);
  const [grantSubmitError, setGrantSubmitError] = useState<unknown>();
  const [pendingRevocation, setPendingRevocation] = useState<PendingRevocation>();
  const [revocationReason, setRevocationReason] = useState("");
  const [revocationSubmitting, setRevocationSubmitting] = useState(false);
  const [revocationError, setRevocationError] = useState<string>();
  const [grantStatusNow, setGrantStatusNow] = useState(() => Date.now());
  const roleRequestRef = useRef(0);
  const grantRequestRef = useRef(0);
  const priorModelWorkspaceTargetRef = useRef<string | undefined>(undefined);
  const [roleForm] = Form.useForm();
  const [grantForm] = Form.useForm();
  const revocationTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const workspaceId = model.authorizationTargetWorkspaceId?.trim() || undefined;
    const priorWorkspaceId = priorModelWorkspaceTargetRef.current;
    priorModelWorkspaceTargetRef.current = workspaceId;
    if (workspaceId && workspaceId !== targetWorkspaceId.trim()) {
      grantRequestRef.current += 1;
      setTargetWorkspaceId(workspaceId);
      setGrants(undefined);
      setGrantsTarget(undefined);
      setGrantLoadError(undefined);
      setGrantLoading(false);
      setPendingRevocation(undefined);
      grantForm.resetFields();
    } else if (!workspaceId && priorWorkspaceId) {
      grantRequestRef.current += 1;
      setTargetWorkspaceId("");
      setGrants(undefined);
      setGrantsTarget(undefined);
      setGrantLoadError(undefined);
      setGrantLoading(false);
      setPendingRevocation(undefined);
      grantForm.resetFields();
    }
  }, [model.authorizationTargetWorkspaceId, grantForm]);

  useEffect(() => {
    if (!grants?.grants.length) return undefined;
    setGrantStatusNow(Date.now());
    const timer = window.setInterval(() => setGrantStatusNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [grants?.grants.length]);

  const requestRevocationReason = (target: PendingRevocation, trigger: HTMLElement | null) => {
    revocationTriggerRef.current = trigger;
    setPendingRevocation(target);
    setRevocationReason("");
    setRevocationError(undefined);
  };

  const closeRevocationDialog = () => {
    if (revocationSubmitting) return;
    setPendingRevocation(undefined);
    setRevocationReason("");
    setRevocationError(undefined);
  };

  if (!canViewAuthorizationGovernance(model.authorization, model.opsSession?.account_login)) return null;

  const currentSubject = subjectIdentityId.trim();
  const currentWorkspace = targetWorkspaceId.trim();
  const currentRoles = roles && rolesTarget === currentSubject ? roles : undefined;
  const currentGrants = grants && grantsTarget?.subjectIdentityId === currentSubject && grantsTarget.workspaceId === currentWorkspace ? grants : undefined;

  const changeSubjectIdentity = (value: string) => {
    roleRequestRef.current += 1;
    grantRequestRef.current += 1;
    setSubjectIdentityId(value);
    setRoles(undefined);
    setRolesTarget(undefined);
    setGrants(undefined);
    setGrantsTarget(undefined);
    setRoleLoadError(undefined);
    setGrantLoadError(undefined);
    setRoleLoading(false);
    setGrantLoading(false);
    setPendingRevocation(undefined);
    grantForm.resetFields();
  };
  const changeTargetWorkspace = (value: string) => {
    grantRequestRef.current += 1;
    setTargetWorkspaceId(value);
    setGrants(undefined);
    setGrantsTarget(undefined);
    setGrantLoadError(undefined);
    setGrantLoading(false);
    setPendingRevocation(undefined);
    grantForm.resetFields();
  };

  const loadRoles = async () => {
    const subjectIdentity = subjectIdentityId.trim();
    if (!subjectIdentity) return;
    const requestId = ++roleRequestRef.current;
    setRoleLoading(true);
    setRoleLoadError(undefined);
    try {
      const result = await rpc<RoleList>("ops.authorization.roles.list", { subject_identity_id: subjectIdentity }) ?? undefined;
      if (requestId === roleRequestRef.current && subjectIdentity === subjectIdentityId.trim()) {
        setRoles(result);
        setRolesTarget(result?.subject_identity_id ?? subjectIdentity);
      }
    } catch (error) {
      if (requestId === roleRequestRef.current && subjectIdentity === subjectIdentityId.trim()) setRoleLoadError(error);
    } finally {
      if (requestId === roleRequestRef.current) setRoleLoading(false);
    }
  };
  const loadGrants = async () => {
    const subjectIdentity = subjectIdentityId.trim();
    const workspaceId = targetWorkspaceId.trim();
    if (!subjectIdentity || !workspaceId) return;
    const requestId = ++grantRequestRef.current;
    setGrantLoading(true);
    setGrantLoadError(undefined);
    try {
      const result = await rpc<GrantList>("ops.authorization.grants.list", { subject_identity_id: subjectIdentity, target_workspace_id: workspaceId }) ?? undefined;
      if (requestId === grantRequestRef.current && subjectIdentity === subjectIdentityId.trim() && workspaceId === targetWorkspaceId.trim()) {
        setGrants(result);
        setGrantsTarget(result ? { subjectIdentityId: result.subject_identity_id, workspaceId: result.workspace_id } : { subjectIdentityId: subjectIdentity, workspaceId });
      }
    }
    catch (error) {
      if (requestId !== grantRequestRef.current || subjectIdentity !== subjectIdentityId.trim() || workspaceId !== targetWorkspaceId.trim()) return;
      // A platform session may not yet have a tenant workspace bound. Treat
      // this as an unavailable optional panel, not an inline page failure.
      const detail = describeOpsError(error);
      if (/401|未授权|会话|workspace/i.test(detail)) {
        setGrantLoadError(undefined);
        message.info("请先选择已授权的商家工作区，再查看临时授权");
      } else setGrantLoadError(error);
    }
    finally { if (requestId === grantRequestRef.current) setGrantLoading(false); }
  };

  const locallyExpiredGrantCount = currentGrants?.grants.filter((grant) => describeGrantStatus(grant, grantStatusNow).label === "已过期").length ?? 0;

  const submitRevocation = async () => {
    if (!pendingRevocation || revocationSubmitting) return;
    if (revocationReason.trim().length < 3) {
      const nextError = "撤销原因至少需要 3 个字符";
      setRevocationError(nextError);
      message.error(nextError);
      return;
    }
    setRevocationSubmitting(true);
    setRevocationError(undefined);
    try {
      if (pendingRevocation.kind === "role") {
        const { role } = pendingRevocation;
        await rpc("ops.authorization.role.revoke", {
          assignment_id: role.id,
          subject_identity_id: role.subjectIdentityId,
          expected_revision: String(role.revision),
          expected_authorization_revision: String(pendingRevocation.authorizationRevision),
          reason: revocationReason.trim(),
        });
        await loadRoles();
      } else {
        const { grant } = pendingRevocation;
        await rpc("ops.authorization.grant.revoke", {
          grant_id: grant.id,
          subject_identity_id: pendingRevocation.subjectIdentityId,
          expected_revision: String(grant.revision),
          expected_authorization_revision: String(pendingRevocation.authorizationRevision),
          reason: revocationReason.trim(),
        });
        model.recordJitRevocation({
          grantId: grant.id,
          workspaceId: grant.workspaceId,
          revokedAt: new Date().toISOString(),
        });
        await loadGrants();
        model.clearAuthorizationScopedData();
        await model.load();
      }
      setPendingRevocation(undefined);
      setRevocationReason("");
      setRevocationError(undefined);
    } catch (error) {
      const nextError = describeOpsError(error);
      setRevocationError(nextError);
      message.error(nextError);
    } finally {
      setRevocationSubmitting(false);
    }
  };

  return <Card className="ops-authorization-card" title="权限与授权" extra={<Tag className="ops-authorization-admin-tag">仅平台超级管理员</Tag>}>
    <div className="ops-authorization-intro">
      <div><Typography.Text className="ops-authorization-eyebrow">ACCESS GOVERNANCE</Typography.Text><Typography.Title level={4}>为指定身份和商家主体授权</Typography.Title></div>
      <Typography.Paragraph>先确认授权目标，再签发限时 JIT。所有变更由服务端重新授权并写入持久审计；平台角色不授予客户正文访问。</Typography.Paragraph>
    </div>
    {targetWorkspaceId ? (
      <div className="ops-authorization-target-context" role="status">已带入商家主体 <Typography.Text code copyable>{targetWorkspaceId}</Typography.Text>。请确认具体用户的持久身份。</div>
    ) : null}
    {canReadGrants ? <section className="ops-authorization-block" aria-labelledby="jit-grants-heading">
      <div className="ops-authorization-section-heading"><div><Typography.Text className="ops-authorization-eyebrow">01 · 授权目标</Typography.Text><Typography.Title id="jit-grants-heading" level={5}>JIT 临时授权</Typography.Title></div><Typography.Text>精确身份 · 精确商家主体</Typography.Text></div>
      <Space orientation="vertical" size="middle" className="full-width">
        <Space wrap className="ops-authorization-target-fields">
          <div className="ops-authorization-target-field"><label htmlFor="jit-subject-identity">目标持久身份 ID</label><Input id="jit-subject-identity" value={subjectIdentityId} onChange={(event) => changeSubjectIdentity(event.target.value)} placeholder="输入目标身份" aria-label="JIT 目标身份 ID" style={{ width: 300 }} /></div>
          <div className="ops-authorization-target-field"><label htmlFor="jit-workspace">商家主体 ID</label><Input id="jit-workspace" value={targetWorkspaceId} onChange={(event) => changeTargetWorkspace(event.target.value)} placeholder="输入精确商家主体" aria-label="JIT 目标商家主体 ID" style={{ width: 260 }} /></div>
          <Button style={{ minHeight: 44 }} onClick={() => void loadGrants()} loading={grantLoading} aria-busy={grantLoading} disabled={!currentSubject || !currentWorkspace}>读取有效 JIT</Button>
        </Space>
        <OpsPageError error={grantLoadError} onRetry={() => void loadGrants()} />
        {locallyExpiredGrantCount ? <div role="status" aria-live="polite" aria-atomic="true">
          <Alert
            showIcon
            type="warning"
            title={`已检测到 ${locallyExpiredGrantCount} 条 JIT 在当前桌面会话中到期`}
            description="这些授权在本地时钟下已失效；请刷新列表或重新签发，避免继续依赖过期快照。"
          />
        </div> : null}
        {model.jitRevocationReceipt ? <div role="status" aria-live="polite" aria-atomic="true">
          <Alert
            showIcon
            type="info"
            title="最近一次 JIT 已撤销"
            description={`授权 ${model.jitRevocationReceipt.grantId} 已于 ${model.jitRevocationReceipt.revokedAt} 撤销，并从工作区 ${model.jitRevocationReceipt.workspaceId} 的有效列表中移除。`}
          />
        </div> : null}
        {canManageGrants && <>
        <OpsPageError error={grantSubmitError} onRetry={() => grantForm.submit()} />
        <div className="ops-jit-issue-panel">
        <div className="ops-jit-issue-heading">
          <div>
            <Typography.Text className="ops-jit-issue-kicker">临时授权</Typography.Text>
            <Typography.Title level={5}>签发 JIT 授权</Typography.Title>
            <Typography.Paragraph>只对指定商家主体和能力生效，提交后由服务端校验审批证据并记录审计。</Typography.Paragraph>
          </div>
          <Tag className="ops-jit-ttl-tag">只读最长 15 分钟 · 写入最长 5 分钟</Tag>
        </div>
        <div className="ops-jit-scope-note" role="status">{describeGrantScope(targetWorkspaceId)}</div>
        {/* The form used to take the approver's name and timestamp as free text,
            which is exactly the forgeable interaction: nothing proved an
            approval act happened, and the typed name was persisted into
            ops_access_grants.approved_by and the audit stream. The proof is now
            a server-issued token the approver holds, so the form demands it and
            explains what it is instead of implying a typed name authorises. */}
        <details className="ops-jit-approval-note"><summary>审批证据来自令牌 · 查看校验规则</summary><p>审批证据来自平台签发给审批人本人的令牌。服务端从请求头解析身份并绑定目标商家；表单中的姓名仅作记录，身份不一致时会拒绝签发。</p></details>
        <Form className="ops-jit-issue-form" form={grantForm} layout="vertical" aria-label="签发 JIT 授权" onFinish={async (values) => {
            if (grantSubmitting) return;
            setGrantSubmitting(true);
            setGrantSubmitError(undefined);
            const capabilities = parseGrantCapabilities(values.capabilities);
            try {
              // The approval token travels as the `x-authorization-approval-token`
              // request header via OpsRpcOptions, never as an rpc param: a body
              // field would recreate the caller-supplied `approved_by` claim that
              // used to satisfy the `approval` obligation, which is the forgeable
              // shape this form previously invited. It is read out of the form at
              // submit time only, never mirrored into component state, and never
              // handed to any persistence helper. The success path below clears it
              // together with the rest of the form; the failure path keeps it so
              // the retry control can resubmit the same evidence.
              const targetIdentity = subjectIdentityId.trim();
              const targetWorkspace = targetWorkspaceId.trim();
              await rpc("ops.authorization.grant.issue", { subject_identity_id: targetIdentity, target_workspace_id: targetWorkspace, grant_kind: "support", access_mode: values.access_mode, capabilities_json: JSON.stringify(capabilities), resource_scope_json: JSON.stringify({ workspace_ids: [targetWorkspace] }), ticket_ref: values.ticket_ref, approved_by: values.approved_by, approved_at: values.approved_at, expires_at: values.expires_at, max_uses: String(values.max_uses), expected_authorization_revision: String(currentGrants?.authorization_revision ?? 0), reason: values.reason }, { authorizationApprovalToken: String(values.approval_token ?? "").trim() });
              grantForm.resetFields();
              await loadGrants();
            } catch (error) {
              setGrantSubmitError(error);
              message.error(describeOpsError(error));
            } finally {
              setGrantSubmitting(false);
            }
          }}>
          <Row gutter={[16, 2]}>
            <Col xs={24} md={12} xl={6}><Form.Item name="access_mode" label="权限模式" initialValue="read" rules={[{ required: true }]}><Select options={[{ value: "read", label: "只读" }, { value: "write", label: "写入（双人）" }]} /></Form.Item></Col>
            <Col xs={24} md={12} xl={6}><Form.Item name="capabilities" label="能力（逗号分隔）" rules={[{ required: true }]}><Input placeholder="support.ticket.read" /></Form.Item></Col>
            <Col xs={24} md={12} xl={6}><Form.Item name="ticket_ref" label="工单/事故" rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col xs={24} md={12} xl={6}><Form.Item name="max_uses" label="最大使用次数" initialValue={1} rules={[{ required: true }]}><InputNumber min={1} max={100} className="full-width" /></Form.Item></Col>
            <Col xs={24} md={12} xl={8}><Form.Item name="approved_by" label="审批人身份" extra="须与令牌绑定的身份一致" rules={[{ required: true, whitespace: true, message: "请填写令牌绑定的审批人身份" }]}><Input /></Form.Item></Col>
            <Col xs={24} md={12} xl={8}><Form.Item name="approval_token" label="审批人令牌" extra="仅随本次请求提交，成功后清空" rules={[{ required: true, whitespace: true, message: "请填写审批人令牌" }]}><Input.Password autoComplete="off" placeholder="由审批人提供的令牌" /></Form.Item></Col>
            <Col xs={24} md={12} xl={8}><Form.Item name="approved_at" label="审批时间（ISO UTC）" extra="仅作记录，不参与审批判定" rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col xs={24} md={12} xl={12}><Form.Item name="expires_at" label="到期时间（读≤15m / 写≤5m）" extra="使用 ISO 时间；提交前会校验有效期与权限模式" rules={[{ required: true }, ({ getFieldValue }) => ({ validator: async (_rule, value) => {
              const error = validateJitExpiry(value, getFieldValue("access_mode") ?? "read");
              if (error) throw new Error(error);
            } })]}><Input aria-label="到期时间（读≤15m / 写≤5m）" aria-describedby="jit-expiry-help" /></Form.Item><span id="jit-expiry-help" className="sr-only">只读权限最多 15 分钟，写入权限最多 5 分钟</span></Col>
            <Col xs={24} md={12} xl={12}><Form.Item name="reason" label="授权原因" rules={[{ required: true, min: 3 }]}><Input aria-label="授权原因" /></Form.Item></Col>
          </Row>
          <Button type="primary" htmlType="submit" style={{ minHeight: 44 }} loading={grantSubmitting} aria-busy={grantSubmitting} disabled={grantSubmitting || !subjectIdentityId.trim() || !targetWorkspaceId.trim()}>签发 JIT</Button>
        </Form></div></>}
        <Table<Grant> size="small" rowKey="id" loading={grantLoading} dataSource={currentGrants?.grants ?? []} pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => `共 ${total} 条` }} locale={{ emptyText: "输入身份与工作区后读取 JIT" }} scroll={{ x: 900 }} columns={[
          { title: "状态", render: (_value, row) => {
            const status = describeGrantStatus(row, grantStatusNow);
            return <Tag color={status.color}>{status.label}</Tag>;
          } },
          { title: "授权模式", dataIndex: "accessMode", render: (value: Grant["accessMode"]) => <Tag color={value === "write" ? "volcano" : "gold"} title={`技术标识：${value}`}>{accessModeLabels[value] ?? value}</Tag> },
          { title: "授权能力", dataIndex: "capabilities", render: (value: string[]) => <Space wrap>{value.map(item => <Tag key={item} title={`技术标识：${item}`}>{readableCapability(item)}</Tag>)}</Space> },
          { title: "工单", dataIndex: "ticketRef" },
          { title: "使用", render: (_value, row) => `${row.useCount}/${row.maxUses}` },
          { title: "到期", dataIndex: "expiresAt" },
          { title: "操作", render: (_value, row) => <Button danger size="small" style={{ minHeight: 44 }} disabled={!canManageGrants || !currentGrants} onClick={(event) => requestRevocationReason({ kind: "grant", title: `立即撤销 ${row.id}`, grant: row, subjectIdentityId: currentGrants!.subject_identity_id, authorizationRevision: currentGrants!.authorization_revision }, event.currentTarget)}>立即撤销</Button> },
        ]} />

      </Space>
    </section> : null}
    {canReadRoles ? <section className="ops-authorization-block" aria-labelledby="platform-roles-heading">
      <Divider><span id="platform-roles-heading">平台角色</span></Divider>
      <Space orientation="vertical" size="middle" className="full-width">
        <Space wrap>
          <Input value={subjectIdentityId} onChange={(event) => changeSubjectIdentity(event.target.value)} placeholder="目标持久身份 ID" aria-label="平台角色目标身份 ID" style={{ width: 320 }} />
          <Button style={{ minHeight: 44 }} onClick={() => void loadRoles()} loading={roleLoading} aria-busy={roleLoading} disabled={!currentSubject}>读取当前分配</Button>
        </Space>
        <OpsPageError error={roleLoadError} onRetry={() => void loadRoles()} />
        <Table<RoleAssignment> size="small" rowKey="id" loading={roleLoading} dataSource={currentRoles?.assignments ?? []} pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => `共 ${total} 条` }} locale={{ emptyText: "输入身份 ID 后读取平台角色" }} columns={[
          { title: "角色", dataIndex: "role", render: (value: string) => <Tag color="blue" title={`技术标识：${value}`}>{platformRoleLabels[value] ?? value}</Tag> },
          { title: "到期", dataIndex: "expiresAt", render: (value?: string) => value ?? "长期" },
          { title: "修订", dataIndex: "revision" },
          { title: "操作", render: (_value, row) => <Button danger size="small" style={{ minHeight: 44 }} disabled={!canManageRoles || !currentRoles} onClick={(event) => requestRevocationReason({ kind: "role", title: `撤销 ${row.role}`, role: row, authorizationRevision: currentRoles!.authorization_revision }, event.currentTarget)}>撤销</Button> },
        ]} />
        {canManageRoles && <>
          <OpsPageError error={roleSubmitError} onRetry={() => roleForm.submit()} />
          <Form form={roleForm} layout="inline" aria-label="分配平台角色" onFinish={async (values) => {
            if (roleSubmitting) return;
            setRoleSubmitting(true);
            setRoleSubmitError(undefined);
            try {
              await rpc("ops.authorization.role.assign", { subject_identity_id: subjectIdentityId.trim(), role: values.role, expected_authorization_revision: String(currentRoles?.authorization_revision ?? 0), reason: values.reason, ...(values.expires_at ? { expires_at: values.expires_at } : {}) });
              roleForm.resetFields();
              await loadRoles();
            } catch (error) {
              setRoleSubmitError(error);
              message.error(describeOpsError(error));
            } finally {
              setRoleSubmitting(false);
            }
          }}>
          <Form.Item name="role" label="平台角色" rules={[{ required: true }]}><Select placeholder={assignableRoles.length ? "选择平台角色" : "等待服务端角色策略"} disabled={!assignableRoles.length} style={{ width: 190 }} options={assignableRoles.map(value => ({ value, label: platformRoleLabels[value] ?? value }))} /></Form.Item>
          <Form.Item name="expires_at" label="到期时间"><Input placeholder="可选：ISO 到期时间" style={{ width: 220 }} /></Form.Item>
          <Form.Item name="reason" label="分配原因" rules={[{ required: true, min: 3 }]}><Input placeholder="说明工单或业务原因" style={{ width: 220 }} /></Form.Item>
          <Button type="primary" htmlType="submit" style={{ minHeight: 44 }} loading={roleSubmitting} aria-busy={roleSubmitting} disabled={roleSubmitting || !subjectIdentityId.trim()}>分配角色</Button>
        </Form></>}
      </Space>
    </section> : null}
    {canReadRoles ? <section className="ops-authorization-block" aria-labelledby="permission-matrix-heading">
      <Typography.Title id="permission-matrix-heading" level={5}>功能权限矩阵</Typography.Title>
      <PermissionMatrixSection onLoaded={(matrix) => setAssignableRoles(matrix.assignable_roles)} />
    </section> : null}
    <DangerActionModal
      open={Boolean(pendingRevocation)}
      title={pendingRevocation?.title ?? "撤销授权"}
      objectLabel={pendingRevocation?.kind === "role" ? "平台角色" : "JIT 授权"}
      objectValue={pendingRevocation?.kind === "role" ? pendingRevocation.role.role : pendingRevocation?.grant.id ?? "未指定"}
      scope={pendingRevocation?.kind === "role" ? "平台全局角色" : `workspace:${pendingRevocation?.grant.workspaceId ?? "未指定"}`}
      impact={pendingRevocation?.kind === "role" ? "撤销后该身份会立即失去对应平台能力。" : "撤销后该身份将立即失去当前工作区的临时访问能力。"}
      revision={pendingRevocation?.kind === "role" ? pendingRevocation.role.revision : pendingRevocation?.grant.revision}
      reason={revocationReason}
      onReasonChange={setRevocationReason}
      onConfirm={submitRevocation}
      onCancel={closeRevocationDialog}
      loading={revocationSubmitting}
      error={revocationError}
      confirmLabel="确认撤销"
      reasonLabel="撤销原因"
      reasonHint="说明撤销原因，包含工单或证据编号。"
      triggerRef={revocationTriggerRef}
    />
  </Card>;
}
