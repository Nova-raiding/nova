import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Card, Col, Form, Input, InputNumber, Row, Select, Space, Table, Tabs, Tag, Typography } from "antd";
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
  | { kind: "role"; title: string; role: RoleAssignment }
  | { kind: "grant"; title: string; grant: Grant };
type GrantStatus = { label: string; color: "green" | "gold" | "orange" | "red" };

const platformRoles = ["platform_admin", "ops_admin", "support_agent", "finance_ops", "security_admin", "auditor", "rules_admin", "model_admin", "release_admin"];

export function parseGrantCapabilities(value: unknown): string[] {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

export function describeGrantScope(workspaceId: string): string {
  const normalized = workspaceId.trim();
  return normalized ? `此 JIT 仅覆盖工作区 ${normalized}，不会自动扩展到其他工作区。` : "填写目标工作区 ID 后，这里会显示精确授权范围。";
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
  const [grants, setGrants] = useState<GrantList>();
  const [roleLoadError, setRoleLoadError] = useState<unknown>();
  const [grantLoadError, setGrantLoadError] = useState<unknown>();
  const [loading, setLoading] = useState(false);
  const [roleSubmitting, setRoleSubmitting] = useState(false);
  const [roleSubmitError, setRoleSubmitError] = useState<unknown>();
  const [grantSubmitting, setGrantSubmitting] = useState(false);
  const [grantSubmitError, setGrantSubmitError] = useState<unknown>();
  const [pendingRevocation, setPendingRevocation] = useState<PendingRevocation>();
  const [revocationReason, setRevocationReason] = useState("");
  const [revocationSubmitting, setRevocationSubmitting] = useState(false);
  const [revocationError, setRevocationError] = useState<string>();
  const [recentGrantRevocation, setRecentGrantRevocation] = useState<{ grantId: string; workspaceId: string; revokedAt: string }>();
  const [grantStatusNow, setGrantStatusNow] = useState(() => Date.now());
  const [roleForm] = Form.useForm();
  const [grantForm] = Form.useForm();
  const revocationTriggerRef = useRef<HTMLElement | null>(null);

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

  if (!canReadRoles && !canReadGrants) return null;

  const loadRoles = async () => {
    if (!subjectIdentityId.trim()) return;
    setLoading(true);
    setRoleLoadError(undefined);
    try { setRoles(await rpc<RoleList>("ops.authorization.roles.list", { subject_identity_id: subjectIdentityId.trim() }) ?? undefined); }
    catch (error) { setRoleLoadError(error); }
    finally { setLoading(false); }
  };
  const loadGrants = async () => {
    if (!subjectIdentityId.trim() || !targetWorkspaceId.trim()) return;
    setLoading(true);
    setGrantLoadError(undefined);
    try { setGrants(await rpc<GrantList>("ops.authorization.grants.list", { subject_identity_id: subjectIdentityId.trim(), target_workspace_id: targetWorkspaceId.trim() }) ?? undefined); }
    catch (error) { setGrantLoadError(error); }
    finally { setLoading(false); }
  };

  const locallyExpiredGrantCount = grants?.grants.filter((grant) => describeGrantStatus(grant, grantStatusNow).label === "已过期").length ?? 0;

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
          expected_authorization_revision: String(roles?.authorization_revision ?? role.authorizationRevision),
          reason: revocationReason.trim(),
        });
        await loadRoles();
      } else {
        const { grant } = pendingRevocation;
        await rpc("ops.authorization.grant.revoke", {
          grant_id: grant.id,
          subject_identity_id: subjectIdentityId.trim(),
          expected_revision: String(grant.revision),
          expected_authorization_revision: String(grants?.authorization_revision ?? grant.authorizationRevision),
          reason: revocationReason.trim(),
        });
        setRecentGrantRevocation({
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

  return <Card title="角色与 JIT 授权中心" extra={<Tag color="purple">平台控制面</Tag>}>
    <Alert showIcon type="info" title="所有变更由服务端重新授权并写入持久审计" description="平台角色不授予客户正文访问；进入客户工作区必须使用精确 workspace、能力、TTL、工单和审批人绑定的 JIT grant。platform_owner 不在日常入口开放。" />
    <Tabs destroyOnHidden items={[
      ...(canReadRoles ? [{ key: "matrix", label: "功能权限矩阵", children: <PermissionMatrixSection /> }] : []),
      ...(canReadRoles ? [{ key: "roles", label: "平台角色", children: <Space orientation="vertical" size="middle" className="full-width">
        <Space wrap>
          <Input value={subjectIdentityId} onChange={(event) => setSubjectIdentityId(event.target.value)} placeholder="目标持久身份 ID" aria-label="平台角色目标身份 ID" style={{ width: 320 }} />
          <Button style={{ minHeight: 44 }} onClick={() => void loadRoles()} loading={loading} disabled={!subjectIdentityId.trim()}>读取当前分配</Button>
        </Space>
        <OpsPageError error={roleLoadError} onRetry={() => void loadRoles()} />
        <Table<RoleAssignment> size="small" rowKey="id" loading={loading} dataSource={roles?.assignments ?? []} pagination={false} locale={{ emptyText: "输入身份 ID 后读取平台角色" }} columns={[
          { title: "角色", dataIndex: "role", render: (value: string) => <Tag color="blue">{value}</Tag> },
          { title: "到期", dataIndex: "expiresAt", render: (value?: string) => value ?? "长期" },
          { title: "修订", dataIndex: "revision" },
          { title: "操作", render: (_value, row) => <Button danger size="small" style={{ minHeight: 44 }} disabled={!canManageRoles} onClick={(event) => requestRevocationReason({ kind: "role", title: `撤销 ${row.role}`, role: row }, event.currentTarget)}>撤销</Button> },
        ]} />
        {canManageRoles && <>
          <OpsPageError error={roleSubmitError} onRetry={() => roleForm.submit()} />
          <Form form={roleForm} layout="inline" aria-label="分配平台角色" onFinish={async (values) => {
            if (roleSubmitting) return;
            setRoleSubmitting(true);
            setRoleSubmitError(undefined);
            try {
              await rpc("ops.authorization.role.assign", { subject_identity_id: subjectIdentityId.trim(), role: values.role, expected_authorization_revision: String(roles?.authorization_revision ?? 0), reason: values.reason, ...(values.expires_at ? { expires_at: values.expires_at } : {}) });
              roleForm.resetFields();
              await loadRoles();
            } catch (error) {
              setRoleSubmitError(error);
              message.error(describeOpsError(error));
            } finally {
              setRoleSubmitting(false);
            }
          }}>
          <Form.Item name="role" label="平台角色" rules={[{ required: true }]}><Select placeholder="选择平台角色" style={{ width: 190 }} options={platformRoles.map(value => ({ value, label: value }))} /></Form.Item>
          <Form.Item name="expires_at" label="到期时间"><Input placeholder="可选：ISO 到期时间" style={{ width: 220 }} /></Form.Item>
          <Form.Item name="reason" label="分配原因" rules={[{ required: true, min: 3 }]}><Input placeholder="说明工单或业务原因" style={{ width: 220 }} /></Form.Item>
          <Button type="primary" htmlType="submit" style={{ minHeight: 44 }} loading={roleSubmitting} aria-busy={roleSubmitting} disabled={roleSubmitting || !subjectIdentityId.trim()}>分配角色</Button>
        </Form></>}
      </Space> }] : []),
      ...(canReadGrants ? [{ key: "grants", label: "JIT 授权", children: <Space orientation="vertical" size="middle" className="full-width">
        <Space wrap>
          <Input value={subjectIdentityId} onChange={(event) => setSubjectIdentityId(event.target.value)} placeholder="目标持久身份 ID" aria-label="JIT 目标身份 ID" style={{ width: 300 }} />
          <Input value={targetWorkspaceId} onChange={(event) => setTargetWorkspaceId(event.target.value)} placeholder="JIT 目标工作区 ID" aria-label="JIT 目标工作区 ID" style={{ width: 260 }} />
          <Button style={{ minHeight: 44 }} onClick={() => void loadGrants()} loading={loading} disabled={!subjectIdentityId.trim() || !targetWorkspaceId.trim()}>读取有效 JIT</Button>
        </Space>
        <OpsPageError error={grantLoadError} onRetry={() => void loadGrants()} />
        {locallyExpiredGrantCount ? <div role="status" aria-live="polite" aria-atomic="true">
          <Alert
            showIcon
            type="warning"
            message={`已检测到 ${locallyExpiredGrantCount} 条 JIT 在当前桌面会话中到期`}
            description="这些授权在本地时钟下已失效；请刷新列表或重新签发，避免继续依赖过期快照。"
          />
        </div> : null}
        {recentGrantRevocation ? <div role="status" aria-live="polite" aria-atomic="true">
          <Alert
            showIcon
            type="info"
            message="最近一次 JIT 已撤销"
            description={`授权 ${recentGrantRevocation.grantId} 已于 ${recentGrantRevocation.revokedAt} 撤销，并从工作区 ${recentGrantRevocation.workspaceId} 的有效列表中移除。`}
          />
        </div> : null}
        <Table<Grant> size="small" rowKey="id" loading={loading} dataSource={grants?.grants ?? []} pagination={false} locale={{ emptyText: "输入身份与工作区后读取 JIT" }} scroll={{ x: 900 }} columns={[
          { title: "状态", render: (_value, row) => {
            const status = describeGrantStatus(row, grantStatusNow);
            return <Tag color={status.color}>{status.label}</Tag>;
          } },
          { title: "模式", dataIndex: "accessMode", render: (value: string) => <Tag color={value === "write" ? "volcano" : "gold"}>{value}</Tag> },
          { title: "能力", dataIndex: "capabilities", render: (value: string[]) => <Typography.Text>{value.join(", ")}</Typography.Text> },
          { title: "工单", dataIndex: "ticketRef" },
          { title: "使用", render: (_value, row) => `${row.useCount}/${row.maxUses}` },
          { title: "到期", dataIndex: "expiresAt" },
          { title: "操作", render: (_value, row) => <Button danger size="small" style={{ minHeight: 44 }} disabled={!canManageGrants} onClick={(event) => requestRevocationReason({ kind: "grant", title: `立即撤销 ${row.id}`, grant: row }, event.currentTarget)}>立即撤销</Button> },
        ]} />
        {canManageGrants && <>
        <OpsPageError error={grantSubmitError} onRetry={() => grantForm.submit()} />
        <Alert showIcon type="info" role="status" title="精确授权范围" description={describeGrantScope(targetWorkspaceId)} />
        <Form form={grantForm} layout="vertical" aria-label="签发 JIT 授权" onFinish={async (values) => {
            if (grantSubmitting) return;
            setGrantSubmitting(true);
            setGrantSubmitError(undefined);
            const capabilities = parseGrantCapabilities(values.capabilities);
            try {
              await rpc("ops.authorization.grant.issue", { subject_identity_id: subjectIdentityId.trim(), target_workspace_id: targetWorkspaceId.trim(), grant_kind: "support", access_mode: values.access_mode, capabilities_json: JSON.stringify(capabilities), resource_scope_json: JSON.stringify({ type: "workspace", ids: [targetWorkspaceId.trim()] }), ticket_ref: values.ticket_ref, approved_by: values.approved_by, approved_at: values.approved_at, expires_at: values.expires_at, max_uses: String(values.max_uses), expected_authorization_revision: String(grants?.authorization_revision ?? 0), reason: values.reason });
              grantForm.resetFields();
              await loadGrants();
            } catch (error) {
              setGrantSubmitError(error);
              message.error(describeOpsError(error));
            } finally {
              setGrantSubmitting(false);
            }
          }}>
          <Row gutter={12}>
            <Col span={4}><Form.Item name="access_mode" label="权限模式" initialValue="read" rules={[{ required: true }]}><Select options={[{ value: "read", label: "只读" }, { value: "write", label: "写入（双人）" }]} /></Form.Item></Col>
            <Col span={8}><Form.Item name="capabilities" label="能力（逗号分隔）" rules={[{ required: true }]}><Input placeholder="support.ticket.read" /></Form.Item></Col>
            <Col span={4}><Form.Item name="ticket_ref" label="工单/事故" rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col span={4}><Form.Item name="max_uses" label="最大使用次数" initialValue={1} rules={[{ required: true }]}><InputNumber min={1} max={100} className="full-width" /></Form.Item></Col>
            <Col span={4}><Form.Item name="approved_by" label="审批人" rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="approved_at" label="审批时间（ISO UTC）" rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="expires_at" label="到期时间（读≤15m / 写≤5m）" extra="使用 ISO 时间；提交前会校验有效期与权限模式" rules={[{ required: true }, ({ getFieldValue }) => ({ validator: async (_rule, value) => {
              const error = validateJitExpiry(value, getFieldValue("access_mode") ?? "read");
              if (error) throw new Error(error);
            } })]}><Input aria-describedby="jit-expiry-help" /><span id="jit-expiry-help" className="sr-only">只读权限最多 15 分钟，写入权限最多 5 分钟</span></Form.Item></Col>
            <Col span={8}><Form.Item name="reason" label="授权原因" rules={[{ required: true, min: 3 }]}><Input /></Form.Item></Col>
          </Row>
          <Button type="primary" htmlType="submit" style={{ minHeight: 44 }} loading={grantSubmitting} aria-busy={grantSubmitting} disabled={grantSubmitting || !subjectIdentityId.trim() || !targetWorkspaceId.trim()}>签发 JIT</Button>
        </Form></>}
      </Space> }] : []),
    ]} />
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
