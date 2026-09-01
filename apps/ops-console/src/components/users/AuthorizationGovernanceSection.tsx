import { useState } from "react";
import { Alert, App, Button, Card, Col, Form, Input, InputNumber, Modal, Row, Select, Space, Table, Tabs, Tag, Typography } from "antd";
import { describeOpsError, rpc } from "../../api/opsClient";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import { OpsPageError } from "../OpsPageError";
import { PermissionMatrixSection } from "./PermissionMatrixSection";

type RoleAssignment = { id: string; role: string; subjectIdentityId: string; expiresAt?: string; revision: number; authorizationRevision: number };
type Grant = { id: string; accessMode: "read" | "write"; workspaceId: string; capabilities: string[]; ticketRef: string; expiresAt: string; useCount: number; maxUses: number; revision: number; authorizationRevision: number };
type RoleList = { subject_identity_id: string; authorization_revision: number; assignments: RoleAssignment[] };
type GrantList = { subject_identity_id: string; workspace_id: string; authorization_revision: number; grants: Grant[] };

const platformRoles = ["platform_admin", "ops_admin", "support_agent", "finance_ops", "security_admin", "auditor", "rules_admin", "model_admin", "release_admin"];

export function parseGrantCapabilities(value: unknown): string[] {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
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
  const [roleForm] = Form.useForm();
  const [grantForm] = Form.useForm();

  const requestRevocationReason = (title: string, onConfirm: (reason: string) => Promise<void>) => {
    let reason = "";
    Modal.confirm({
      title,
      content: <label style={{ display: "block" }}>
        <span>撤销原因（至少 3 个字符）</span>
        <Input.TextArea autoFocus rows={3} aria-label="撤销原因" placeholder="说明撤销原因，包含工单或证据编号" onChange={(event) => { reason = event.target.value; }} />
      </label>,
      okText: "确认撤销",
      okButtonProps: { danger: true },
      cancelText: "取消",
      async onOk() {
        if (reason.trim().length < 3) {
          message.error("撤销原因至少需要 3 个字符");
          throw new Error("revocation reason is required");
        }
        try {
          await onConfirm(reason.trim());
        } catch (error) {
          message.error(error instanceof Error ? error.message : "撤销失败");
          throw error;
        }
      },
    });
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
          { title: "操作", render: (_value, row) => <Button danger size="small" style={{ minHeight: 44 }} disabled={!canManageRoles} onClick={() => requestRevocationReason(`撤销 ${row.role}`, async (reason) => { await rpc("ops.authorization.role.revoke", { assignment_id: row.id, subject_identity_id: row.subjectIdentityId, expected_revision: String(row.revision), expected_authorization_revision: String(roles?.authorization_revision ?? row.authorizationRevision), reason }); await loadRoles(); })}>撤销</Button> },
        ]} />
        {canManageRoles && <>
          <OpsPageError error={roleSubmitError} />
          <Form form={roleForm} layout="inline" onFinish={async (values) => {
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
          <Form.Item name="role" rules={[{ required: true }]}><Select placeholder="选择平台角色" style={{ width: 190 }} options={platformRoles.map(value => ({ value, label: value }))} /></Form.Item>
          <Form.Item name="expires_at"><Input placeholder="可选：ISO 到期时间" style={{ width: 220 }} /></Form.Item>
          <Form.Item name="reason" rules={[{ required: true, min: 3 }]}><Input placeholder="分配原因" style={{ width: 220 }} /></Form.Item>
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
        <Table<Grant> size="small" rowKey="id" loading={loading} dataSource={grants?.grants ?? []} pagination={false} locale={{ emptyText: "输入身份与工作区后读取 JIT" }} scroll={{ x: 900 }} columns={[
          { title: "模式", dataIndex: "accessMode", render: (value: string) => <Tag color={value === "write" ? "volcano" : "gold"}>{value}</Tag> },
          { title: "能力", dataIndex: "capabilities", render: (value: string[]) => <Typography.Text>{value.join(", ")}</Typography.Text> },
          { title: "工单", dataIndex: "ticketRef" },
          { title: "使用", render: (_value, row) => `${row.useCount}/${row.maxUses}` },
          { title: "到期", dataIndex: "expiresAt" },
          { title: "操作", render: (_value, row) => <Button danger size="small" style={{ minHeight: 44 }} disabled={!canManageGrants} onClick={() => requestRevocationReason(`立即撤销 ${row.id}`, async (reason) => { await rpc("ops.authorization.grant.revoke", { grant_id: row.id, subject_identity_id: subjectIdentityId.trim(), expected_revision: String(row.revision), expected_authorization_revision: String(grants?.authorization_revision ?? row.authorizationRevision), reason }); await loadGrants(); model.clearAuthorizationScopedData(); await model.load(); })}>立即撤销</Button> },
        ]} />
        {canManageGrants && <>
          <OpsPageError error={grantSubmitError} />
          <Form form={grantForm} layout="vertical" onFinish={async (values) => {
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
            <Col span={8}><Form.Item name="expires_at" label="到期时间（读≤15m / 写≤5m）" rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="reason" label="授权原因" rules={[{ required: true, min: 3 }]}><Input /></Form.Item></Col>
          </Row>
          <Button type="primary" htmlType="submit" style={{ minHeight: 44 }} loading={grantSubmitting} aria-busy={grantSubmitting} disabled={grantSubmitting || !subjectIdentityId.trim() || !targetWorkspaceId.trim()}>签发 JIT</Button>
        </Form></>}
      </Space> }] : []),
    ]} />
  </Card>;
}
