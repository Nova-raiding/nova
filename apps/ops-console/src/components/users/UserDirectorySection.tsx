import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Col, Descriptions, Drawer, Form, Input, Modal, Row, Select, Space, Spin, Statistic, Table, Tag, Typography } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import type { PlatformUser } from "../../types/ops";

type UserFilters = { query?: string; status?: string; workspaceId?: string };
const roleLabels: Record<string, string> = { workspace_owner: "工作区所有者", merchant_admin: "商家管理员", operator: "运营", support: "支持", finance: "财务", platform_ops: "平台运营" };
const memberStatusLabels: Record<string, string> = { active: "已激活", invited: "待激活", suspended: "已停用" };
const workspaceStatusLabels: Record<string, string> = { active: "正常", disabled: "已停用" };
const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

export function UserDirectorySection({ model }: { model: OpsConsoleModel }) {
  const [form] = Form.useForm<UserFilters>();
  const [accessTarget, setAccessTarget] = useState<PlatformUser>();
  const [suspendReason, setSuspendReason] = useState("");
  const [suspending, setSuspending] = useState(false);
  const [detailSubject, setDetailSubject] = useState<string>();
  const [identityAction, setIdentityAction] = useState<"active" | "suspended">();
  const [identityReason, setIdentityReason] = useState("");
  const [riskDecision, setRiskDecision] = useState<"allow" | "step_up" | "block">();
  const [riskLevel, setRiskLevel] = useState<"low" | "medium" | "high" | "critical">("low");
  const [sessionTarget, setSessionTarget] = useState<{ id: string; revision: number }>();
  const [sessionReason, setSessionReason] = useState("");
  const detailTriggerSubjectRef = useRef<string | undefined>(undefined);
  const detailButtonRefs = useRef(new Map<string, HTMLElement>());

  useEffect(() => { if (model.canUserGovernance) void model.loadUsers(); }, [model.canUserGovernance]);

  const submitAccessChange = async () => {
    if (!accessTarget || suspendReason.trim().length < 4) return;
    setSuspending(true);
    const saved = accessTarget.status === "suspended"
      ? await model.activateUser(accessTarget.workspaceId, accessTarget.externalSubject, suspendReason.trim())
      : await model.suspendUser(accessTarget.workspaceId, accessTarget.externalSubject, suspendReason.trim());
    setSuspending(false);
    if (saved) { setAccessTarget(undefined); setSuspendReason(""); }
  };
  const closeUserDetail = () => {
    const triggerSubject = detailTriggerSubjectRef.current;
    setDetailSubject(undefined);
    model.setUserDetail(undefined);
    window.setTimeout(() => {
      if (triggerSubject) detailButtonRefs.current.get(triggerSubject)?.focus({ preventScroll: true });
    }, 400);
  };

  return <>
    {!model.canUserGovernance && <Alert showIcon type="warning" title="当前账号只有工作区权限" description="跨租户用户成员目录仅向 platform_ops 开放；工作区成员仍可在账务与商业配置中管理。" />}
    <Row gutter={[16, 16]}>
      <Col xs={24} md={8}><Card><Statistic title="用户身份" value={model.userDirectory.identityCount} /></Card></Col>
      <Col xs={24} md={8}><Card><Statistic title="成员关系" value={model.userDirectory.total} /></Card></Col>
      <Col xs={24} md={8}><Card><Statistic title="涉及租户" value={model.userDirectory.workspaceCount} /></Card></Col>
    </Row>
    <Card title="用户目录">
      <Form<UserFilters> form={form} layout="inline" onFinish={(values) => void model.loadUsers({ ...values, page: 1 })} aria-label="用户目录筛选">
        <Form.Item name="query" label="关键词"><Input allowClear placeholder="身份、姓名、角色或工作区" /></Form.Item>
        <Form.Item name="status" label="状态">
          <Select allowClear placeholder="全部状态" style={{ width: 140 }} options={[
            { value: "active", label: "已激活" }, { value: "invited", label: "待激活" }, { value: "suspended", label: "已停用" },
          ]} />
        </Form.Item>
        <Form.Item name="workspaceId" label="租户"><Input allowClear placeholder="工作区 ID" /></Form.Item>
        <Form.Item><Space>
          <Button type="primary" htmlType="submit" loading={model.userDirectoryLoading}>查询</Button>
          <Button onClick={() => { form.resetFields(); void model.loadUsers({ page: 1 }); }}>清空</Button>
        </Space></Form.Item>
      </Form>
      {model.userDirectory.truncated && <Alert className="ops-inline-alert" showIcon type="info" title="结果超过 500 条，请增加筛选条件。" />}
      <Table<PlatformUser>
        rowKey={(row) => `${row.workspaceId}:${row.externalSubject}`}
        loading={model.userDirectoryLoading}
        dataSource={model.userDirectory.items}
        locale={{ emptyText: "没有符合条件的用户成员关系" }}
        pagination={{ current: Math.floor(model.userDirectory.offset / model.userDirectory.limit) + 1, pageSize: model.userDirectory.limit, total: model.userDirectory.total, showSizeChanger: true, showTotal: (total) => `共 ${total} 条成员关系` }}
        onChange={(pagination) => void model.loadUsers({ ...form.getFieldsValue(), page: pagination.current ?? 1, pageSize: pagination.pageSize ?? 20 })}
        scroll={{ x: 980 }}
        columns={[
          { title: "身份标识", dataIndex: "externalSubject", width: 190 },
          { title: "显示名", dataIndex: "displayName", width: 140, render: (value: string) => value || "—" },
          { title: "租户", dataIndex: "workspaceId", width: 180 },
          { title: "角色", dataIndex: "role", width: 140, render: (value: string) => <Tag color="blue">{roleLabels[value] ?? value}</Tag> },
          { title: "成员状态", dataIndex: "status", width: 110, render: (value: string) => <Tag color={value === "active" ? "green" : value === "suspended" ? "red" : "gold"}>{memberStatusLabels[value] ?? value}</Tag> },
          { title: "租户状态", dataIndex: "workspaceStatus", width: 110, render: (value: string) => <Tag color={value === "active" ? "green" : "default"}>{workspaceStatusLabels[value] ?? value}</Tag> },
          { title: "更新时间", dataIndex: "updatedAt", width: 180, render: (value: string) => dateTimeFormatter.format(new Date(value)) },
          { title: "操作", key: "actions", width: 170, render: (_: unknown, row: PlatformUser) => <Space size="small"><Button ref={(node) => { if (node) detailButtonRefs.current.set(row.externalSubject, node); else detailButtonRefs.current.delete(row.externalSubject); }} size="small" onClick={() => { detailTriggerSubjectRef.current = row.externalSubject; setDetailSubject(row.externalSubject); void model.loadUserDetail(row.externalSubject, row.identityId); }}>详情</Button><Button danger={row.status !== "suspended"} size="small" title={row.externalSubject === model.opsSession?.actor_id ? "不能停用当前登录账号" : undefined} disabled={!model.canUserGovernance || (row.status !== "suspended" && row.externalSubject === model.opsSession?.actor_id)} onClick={() => setAccessTarget(row)}>{row.status === "suspended" ? "恢复" : "停用"}</Button></Space> },
        ]}
      />
    </Card>
    <Drawer title={`用户详情 · ${detailSubject ?? ""}`} size="large" open={Boolean(detailSubject)} onClose={closeUserDetail} destroyOnHidden>
      <Spin spinning={model.userDetailLoading}>
        {model.userDetail && <Space orientation="vertical" size="large" className="full-width">
          <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }} items={[
            { key: "subject", label: "身份标识", children: <Typography.Text className="ops-token" copyable>{model.userDetail.identity.externalSubject}</Typography.Text> },
            { key: "name", label: "显示名", children: model.userDetail.identity.displayName || "—" },
            { key: "members", label: "成员关系", children: `${model.userDetail.identity.activeMembershipCount} 个有效 / ${model.userDetail.identity.membershipCount} 个总计` },
            { key: "first", label: "首次出现", children: dateTimeFormatter.format(new Date(model.userDetail.identity.firstSeenAt)) },
            { key: "updated", label: "最近更新", children: dateTimeFormatter.format(new Date(model.userDetail.identity.lastUpdatedAt)) },
            { key: "access", label: "平台身份状态", children: model.userDetail.identity.accessStatus ? <Tag color={model.userDetail.identity.accessStatus === "active" ? "green" : "red"}>{model.userDetail.identity.accessStatus === "active" ? "正常" : "全局停用"}</Tag> : "尚未绑定持久身份" },
            { key: "risk", label: "风险策略", children: model.userDetail.identity.riskDecision ? <Tag color={model.userDetail.identity.riskDecision === "allow" ? "green" : model.userDetail.identity.riskDecision === "step_up" ? "gold" : "red"}>{model.userDetail.identity.riskLevel} / {model.userDetail.identity.riskDecision}</Tag> : "—" },
          ]} />
          {model.userDetail.identity.id ? <Alert showIcon type="warning" title="平台身份操作会影响所有租户" description={<Space wrap><Button danger={model.userDetail.identity.accessStatus === "active"} onClick={() => setIdentityAction(model.userDetail!.identity.accessStatus === "active" ? "suspended" : "active")}>{model.userDetail.identity.accessStatus === "active" ? "全局停用并撤销会话" : "恢复平台身份"}</Button><Button onClick={() => { setRiskLevel(model.userDetail!.identity.riskLevel ?? "low"); setRiskDecision(model.userDetail!.identity.riskDecision ?? "allow"); }}>调整风险策略</Button></Space>} /> : <Alert showIcon type="info" title="该成员尚未绑定持久平台身份" description="用户下次通过严格认证登录后，系统会绑定身份和会话；当前只能治理单个工作区成员关系。" />}
          {model.userDetail.sessions.length > 0 && <div><Typography.Title level={5}>认证会话（已脱敏）</Typography.Title><Table size="small" rowKey="id" pagination={false} scroll={{ x: 760 }} dataSource={model.userDetail.sessions} columns={[
            { title: "类型", dataIndex: "sessionKind", width: 100 },
            { title: "状态", dataIndex: "status", width: 100, render: (value: string) => <Tag color={value === "active" ? "green" : "default"}>{value}</Tag> },
            { title: "MFA", dataIndex: "mfaVerified", width: 80, render: (value: boolean) => value ? "已验证" : "否" },
            { title: "最后访问", dataIndex: "lastSeenAt", width: 180, render: (value: string) => dateTimeFormatter.format(new Date(value)) },
            { title: "操作", key: "action", width: 110, render: (_: unknown, row: { id: string; revision: number; status: string }) => <Button danger size="small" disabled={row.status !== "active"} onClick={() => setSessionTarget({ id: row.id, revision: row.revision })}>撤销</Button> },
          ]} /></div>}
          <div><Typography.Title level={5}>所属租户与角色</Typography.Title><Table size="small" rowKey={(row) => `${row.workspaceId}:${row.externalSubject}`} pagination={false} scroll={{ x: 620 }} dataSource={model.userDetail.memberships} columns={[
            { title: "租户", dataIndex: "workspaceId", width: 180 },
            { title: "角色", dataIndex: "role", width: 140, render: (value: string) => roleLabels[value] ?? value },
            { title: "成员状态", dataIndex: "status", width: 110, render: (value: string) => memberStatusLabels[value] ?? value },
            { title: "租户状态", dataIndex: "workspaceStatus", width: 110, render: (value: string) => workspaceStatusLabels[value] ?? value },
          ]} /></div>
          <div><Typography.Title level={5}>成员操作历史</Typography.Title><Table size="small" rowKey="id" pagination={{ pageSize: 8 }} locale={{ emptyText: "暂无成员操作记录" }} scroll={{ x: 680 }} dataSource={model.userDetail.audits} columns={[
            { title: "时间", dataIndex: "createdAt", width: 180, render: (value: string) => dateTimeFormatter.format(new Date(value)) },
            { title: "操作", dataIndex: "action", width: 140 },
            { title: "操作者", dataIndex: "actorId", width: 150 },
            { title: "原因", dataIndex: "reason", width: 220, render: (value: string) => value || "—" },
          ]} /></div>
        </Space>}
      </Spin>
    </Drawer>
    <Modal
      title={accessTarget?.status === "suspended" ? "恢复用户访问" : "停用用户访问"} open={Boolean(accessTarget)} okText={accessTarget?.status === "suspended" ? "确认恢复" : "确认停用"}
      okButtonProps={{ danger: accessTarget?.status !== "suspended", disabled: suspendReason.trim().length < 4 }}
      confirmLoading={suspending} onOk={() => void submitAccessChange()}
      onCancel={() => { if (!suspending) { setAccessTarget(undefined); setSuspendReason(""); } }}
    >
      <Typography.Paragraph>{accessTarget?.status === "suspended" ? "恢复" : "仅停用"} <Typography.Text code>{accessTarget?.externalSubject}</Typography.Text> 在工作区 <Typography.Text code>{accessTarget?.workspaceId}</Typography.Text> 的访问，不会删除业务数据。</Typography.Paragraph>
      <label htmlFor="suspend-reason">操作原因（至少 4 个字符）</label>
      <Input.TextArea id="suspend-reason" autoFocus rows={4} maxLength={500} showCount value={suspendReason} onChange={(event) => setSuspendReason(event.target.value)} placeholder="例如：按工单 OPS-123 撤销或恢复访问" />
    </Modal>
    <Modal title={identityAction === "suspended" ? "全局停用平台身份" : "恢复平台身份"} open={Boolean(identityAction)} okText="确认执行" okButtonProps={{ danger: identityAction === "suspended", disabled: identityReason.trim().length < 4 }} onCancel={() => { setIdentityAction(undefined); setIdentityReason(""); }} onOk={async () => { if (identityAction && await model.changeIdentityAccess(identityAction, identityReason.trim())) { setIdentityAction(undefined); setIdentityReason(""); } }}>
      <Alert showIcon type={identityAction === "suspended" ? "error" : "warning"} title={identityAction === "suspended" ? "该用户在所有租户的访问将立即失效，活动会话会被撤销。" : "只恢复身份状态；旧会话不会复活，用户必须重新登录。"} />
      <label htmlFor="identity-reason">操作原因（至少 4 个字符）</label><Input.TextArea id="identity-reason" rows={4} value={identityReason} onChange={(event) => setIdentityReason(event.target.value)} />
    </Modal>
    <Modal title="调整身份风险策略" open={Boolean(riskDecision)} okText="保存风险策略" okButtonProps={{ danger: riskDecision === "block", disabled: identityReason.trim().length < 4 }} onCancel={() => { setRiskDecision(undefined); setIdentityReason(""); }} onOk={async () => { if (riskDecision && await model.transitionIdentityRisk(riskLevel, riskDecision, identityReason.trim())) { setRiskDecision(undefined); setIdentityReason(""); } }}>
      <Space orientation="vertical" className="full-width"><Select value={riskLevel} onChange={setRiskLevel} options={[{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "critical" }]} /><Select value={riskDecision} onChange={setRiskDecision} options={[{ value: "allow", label: "允许" }, { value: "step_up", label: "要求 MFA" }, { value: "block", label: "阻断并撤销会话" }]} /><Input.TextArea aria-label="风险策略原因" rows={4} value={identityReason} onChange={(event) => setIdentityReason(event.target.value)} placeholder="填写风险证据或工单原因" /></Space>
    </Modal>
    <Modal title="撤销认证会话" open={Boolean(sessionTarget)} okText="确认撤销" okButtonProps={{ danger: true, disabled: sessionReason.trim().length < 4 }} onCancel={() => { setSessionTarget(undefined); setSessionReason(""); }} onOk={async () => { if (sessionTarget && await model.revokeIdentitySession(sessionTarget.id, sessionTarget.revision, sessionReason.trim())) { setSessionTarget(undefined); setSessionReason(""); } }}><Input.TextArea aria-label="会话撤销原因" rows={4} value={sessionReason} onChange={(event) => setSessionReason(event.target.value)} placeholder="填写会话撤销原因或工单号" /></Modal>
  </>;
}
