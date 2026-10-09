import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Descriptions, Dropdown, Drawer, Empty, Form, Input, Modal, Select, Space, Spin, Table, Tag, Typography } from "antd";
import type { MenuProps } from "antd";
import type { TableProps } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import type { PlatformUser } from "../../types/ops";
import { EnterpriseIdentity } from "../EnterpriseIdentity.js";
import { opsRestPost, describeOpsError } from "../../api/opsClient.js";
import { canExportUserDirectory } from "../../api/userDirectoryPermission.js";

type MerchantInvitationView = {
  account: { id: string; login: string; workspaceIds: string[]; status: string };
  invitation: { id: string; expires_at: string; status: string; activation_link?: string; replayed: boolean; delivery_status: "not_sent"; next_action?: string };
  commercial_qualification_granted: false;
  capabilities_granted: string[];
};
type MerchantInvitationForm = { login: string; enterpriseName: string; contactName: string; workspaceId?: string; workspaceMode: "new" | "existing"; reason: string };
type UserFilters = { query?: string; status?: string; workspaceId?: string; accountType?: "all" | "merchant" | "platform" };
const roleLabels: Record<string, string> = { workspace_owner: "企业所有者", merchant_admin: "企业管理员", operator: "运营", support: "支持", finance: "财务", platform_ops: "平台运营" };
const memberStatusLabels: Record<string, string> = { active: "已激活", invited: "待激活", suspended: "已停用" };
const workspaceStatusLabels: Record<string, string> = { active: "正常", disabled: "已停用" };
const lifecycleEventLabels: Record<string, string> = {
  "identity.observed": "身份首次识别",
  "identity.suspended": "全局停用身份",
  "identity.active": "恢复平台身份",
  "identity.risk.transition": "调整风险策略",
  "session.revoked": "撤销认证会话",
};
const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
function formatKnownDateTime(value?: string | null) {
  if (!value) return "未提供";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未提供" : dateTimeFormatter.format(date);
}
export function userDirectoryPageRequest(filters: UserFilters, current?: number, pageSize?: number) {
  return {
    ...(filters.query?.trim() ? { query: filters.query.trim() } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.workspaceId?.trim() ? { workspaceId: filters.workspaceId.trim() } : {}),
    ...(filters.accountType ? { accountType: filters.accountType } : {}),
    page: current ?? 1,
    pageSize: pageSize ?? 10,
  };
}

export function canWriteLoadedIdentity(model: Pick<OpsConsoleModel, "canUserGovernance" | "userDetail" | "userDetailLoading">) {
  return model.canUserGovernance && !model.userDetailLoading && Boolean(model.userDetail?.identity.id);
}

export function legacyCommercialSnapshotRows(memberships: readonly PlatformUser[]) {
  return memberships.filter((row) => Boolean(row.commercial));
}

export function membershipAccessActionContext(row: PlatformUser) {
  const action = row.status === "suspended" ? "启用" : "停用";
  const target = `${row.displayName || row.externalSubject} · ${row.enterpriseName || "未命名企业"}（${row.workspaceId}）`;
  return {
    action,
    status: memberStatusLabels[row.status] ?? "状态待确认",
    target,
    buttonLabel: `${action} ${target} 的成员访问`,
  };
}

export function userDirectoryRowKey(row: PlatformUser) {
  return `${row.accountType ?? "merchant"}:${row.workspaceId}:${row.externalSubject}`;
}

export function failedUserDirectorySelectionKeys(
  targets: readonly { workspaceId: string; externalSubject: string }[],
  failedTargets: readonly { workspaceId: string; externalSubject: string }[],
  currentActionableTargets: readonly { workspaceId: string; externalSubject: string }[],
) {
  const failed = new Set(failedTargets.map((target) => `${target.workspaceId}:${target.externalSubject}`));
  const actionable = new Set(currentActionableTargets.map((target) => `${target.workspaceId}:${target.externalSubject}`));
  return targets
    .filter((target) => {
      const key = `${target.workspaceId}:${target.externalSubject}`;
      return failed.has(key) && actionable.has(key);
    })
    .map((target) => `merchant:${target.workspaceId}:${target.externalSubject}`);
}

export function UserDirectorySection({ model, governanceSections = [], onSelectGovernanceSection }: {
  model: OpsConsoleModel;
  governanceSections?: Array<{ key: string; label: string }>;
  onSelectGovernanceSection?: (key: string) => void;
}) {
  const canReadUserDirectory = model.authorization.can("identity.read");
  const [form] = Form.useForm<UserFilters>();
  const accountType = Form.useWatch("accountType", form) ?? "merchant";
  const displayedAccountType = model.userDirectoryFilters?.accountType ?? "merchant";
  const [accessTarget, setAccessTarget] = useState<PlatformUser>();
  const [suspendReason, setSuspendReason] = useState("");
  const [suspending, setSuspending] = useState(false);
  const [detailSubject, setDetailSubject] = useState<string>();
  const [identityAction, setIdentityAction] = useState<"active" | "suspended">();
  const [identityReason, setIdentityReason] = useState("");
  const [riskDecision, setRiskDecision] = useState<"allow" | "step_up" | "block">();
  const [riskLevel, setRiskLevel] = useState<"low" | "medium" | "high" | "critical">("low");
  const [selectedUserKeys, setSelectedUserKeys] = useState<string[]>([]);
  const [bulkSuspendOpen, setBulkSuspendOpen] = useState(false);
  const [bulkSuspendReason, setBulkSuspendReason] = useState("");
  const [bulkSuspending, setBulkSuspending] = useState(false);
  const [provisionOpen, setProvisionOpen] = useState(false);
  const [provisionSubmitting, setProvisionSubmitting] = useState(false);
  const [provisionResult, setProvisionResult] = useState<MerchantInvitationView>();
  const [provisionError, setProvisionError] = useState("");
  const [provisionUnknown, setProvisionUnknown] = useState(false);
  const provisionIntentRef = useRef<Record<string, unknown> | undefined>(undefined);
  const [provisionForm] = Form.useForm<MerchantInvitationForm>();
  const provisionWorkspaceMode = Form.useWatch("workspaceMode", provisionForm) ?? "new";
  const [provisionWorkspaceQuery, setProvisionWorkspaceQuery] = useState("");
  const [provisionWorkspaceQueryApplied, setProvisionWorkspaceQueryApplied] = useState<string>();
  const provisionWorkspaceRequestRef = useRef(0);
  const [actionError, setActionError] = useState("");
  const actionErrorRef = useRef<HTMLDivElement>(null);
  const directoryErrorRef = useRef<HTMLDivElement>(null);
  const [detailAccountType, setDetailAccountType] = useState<"merchant" | "platform">("merchant");
  const detailTriggerRowKeyRef = useRef<string | undefined>(undefined);
  const detailButtonRefs = useRef(new Map<string, HTMLElement>());
  const identityWritesDisabled = !canWriteLoadedIdentity(model);
  const initialDirectoryLoadFailed = Boolean(model.userDirectoryError && !model.userDirectoryLoading && model.userDirectory.items.length === 0);
  const directoryResultUnread = model.userDirectory.items.length === 0 && Boolean(model.userDirectoryLoading || model.userDirectoryError);
  const unreadDirectoryLabel = model.userDirectoryLoading ? "正在读取用户目录" : "用户目录未读取";

  useEffect(() => {
    if (actionError) actionErrorRef.current?.focus({ preventScroll: true });
  }, [actionError]);

  useEffect(() => {
    if (initialDirectoryLoadFailed) directoryErrorRef.current?.focus({ preventScroll: true });
  }, [initialDirectoryLoadFailed]);

  useEffect(() => {
    if (canReadUserDirectory) void model.loadUsers();
    return () => model.cancelUserRequests();
  }, [canReadUserDirectory]);

  const submitAccessChange = async () => {
    if (!accessTarget || suspendReason.trim().length < 4) {
      setActionError("请填写至少 4 个字符的操作原因。");
      return;
    }
    setActionError("");
    setSuspending(true);
    const saved = accessTarget.status === "suspended"
      ? await model.activateUser(accessTarget.workspaceId, accessTarget.externalSubject, suspendReason.trim())
      : await model.suspendUser(accessTarget.workspaceId, accessTarget.externalSubject, suspendReason.trim());
    setSuspending(false);
    if (saved) { setAccessTarget(undefined); setSuspendReason(""); }
    else setActionError("用户访问状态未更新。请检查权限、版本冲突或连接状态后重试；已保留操作原因。");
  };
  const closeUserDetail = () => {
    setDetailSubject(undefined);
    setDetailAccountType("merchant");
    model.setUserDetail(undefined);
  };
  const restoreUserDetailFocus = () => {
    const triggerRowKey = detailTriggerRowKeyRef.current;
    detailTriggerRowKeyRef.current = undefined;
    if (triggerRowKey) {
      const focusTrigger = () => {
        const trigger = detailButtonRefs.current.get(triggerRowKey);
        if (!trigger) return;
        trigger.focus({ preventScroll: true });
        if (document.activeElement === trigger) detailTriggerRowKeyRef.current = undefined;
      };
      window.requestAnimationFrame(() => window.setTimeout(focusTrigger, 120));
    }
  };
  useEffect(() => {
    // With destroyOnHidden, Drawer may finish its close transition before the
    // table row has been committed again. Retry from the post-state commit so
    // keyboard users reliably return to the control that opened the drawer.
    if (detailSubject !== undefined || !detailTriggerRowKeyRef.current) return;
    restoreUserDetailFocus();
  }, [detailSubject]);
  const selectedUsers = model.userDirectory.items
    .filter((row) => selectedUserKeys.includes(`${row.accountType ?? "merchant"}:${row.workspaceId}:${row.externalSubject}`))
    .map((row) => ({ workspaceId: row.workspaceId, externalSubject: row.externalSubject, revision: row.revision }));
  const governanceMenuItems: NonNullable<MenuProps["items"]> = [
    ...(governanceSections.map(({ key, label }) => ({ key, label }))),
    { key: "accountType", label: accountType === "platform" ? "返回全部账号" : "查看运营平台账号", disabled: !canReadUserDirectory },
    { key: "export", label: "导出商户成员", disabled: accountType !== "merchant" || !canExportUserDirectory(model.authorization) || model.userExporting },
    { key: "provision", label: "开通商家账号", disabled: !model.canPlatformOps },
  ];
  const handleGovernanceMenuClick: MenuProps["onClick"] = ({ key }) => {
    if (key === "accountType") {
      const nextAccountType = accountType === "platform" ? "all" : "platform";
      setSelectedUserKeys([]);
      form.setFieldValue("accountType", nextAccountType);
      void model.loadUsers({ ...form.getFieldsValue(), accountType: nextAccountType, page: 1 });
    } else if (key === "export") {
      void model.exportUsers(form.getFieldsValue());
    } else if (key === "provision") {
      // Invalidate any lookup started by a previous opening before exposing
      // this dialog. A late response must not make an old search selectable.
      provisionWorkspaceRequestRef.current += 1;
      if (!provisionUnknown && provisionResult) { setProvisionResult(undefined); provisionForm.resetFields(); provisionIntentRef.current = undefined; }
      setProvisionWorkspaceQuery("");
      setProvisionWorkspaceQueryApplied(undefined);
      setProvisionOpen(true);
    } else {
      onSelectGovernanceSection?.(key);
    }
  };
  const submitBulkSuspend = async () => {
    if (bulkSuspendReason.trim().length < 4 || !selectedUsers.length) {
      setActionError(!selectedUsers.length ? "请至少选择一个可操作成员。" : "请填写至少 4 个字符的操作原因。");
      return;
    }
    setActionError("");
    setBulkSuspending(true);
    const result = await model.suspendUsers(selectedUsers, bulkSuspendReason.trim());
    setBulkSuspending(false);
    if (result.failed === 0) {
      setSelectedUserKeys([]);
      setBulkSuspendOpen(false);
      setBulkSuspendReason("");
    } else {
      const actionableTargets = model.userDirectory.items
        .filter((row) => row.accountType !== "platform" && row.status !== "suspended" && row.externalSubject !== model.opsSession?.actor_id)
        .map((row) => ({ workspaceId: row.workspaceId, externalSubject: row.externalSubject }));
      setSelectedUserKeys(failedUserDirectorySelectionKeys(selectedUsers, result.failedTargets, actionableTargets));
      setActionError(`已成功停用 ${result.succeeded} 个成员关系；${result.failed} 个未完成。刷新后只保留仍可操作的失败成员，成功或已停用成员不会重试。请复核失败原因后再操作。`);
    }
  };
  const handleDirectoryChange: TableProps<PlatformUser>["onChange"] = (pagination, _filters, _sorter, extra) => {
    if (extra.action !== "paginate") return;
    setSelectedUserKeys([]);
    void model.loadUsers(userDirectoryPageRequest(form.getFieldsValue(), pagination.current, pagination.pageSize));
  };

  return <>
    {!canReadUserDirectory && <Alert showIcon type="warning" title="当前角色不能读取用户目录" description="跨租户身份与成员关系需要 identity.read；权限由服务端策略决定。" />}
    {canReadUserDirectory && !model.canUserGovernance && <Alert showIcon type="info" title="当前为只读视图" description="可以查询身份、成员关系和审计详情，但停用、恢复、风险策略与会话撤销需要 identity.update。" />}
    <h2 id="user-directory-heading" className="sr-only">{displayedAccountType === "platform" ? "运营平台用户" : "已接入用户"}</h2>
      <Card className="ops-user-directory-card" title={displayedAccountType === "platform" ? "运营平台用户" : "已接入用户"} extra={<Dropdown menu={{ items: governanceMenuItems, onClick: handleGovernanceMenuClick }}><Button type="text" aria-label={`更多用户治理操作${governanceSections.length ? `：${governanceSections.map(({ label }) => label).join("、")}` : ""}`} className="ops-user-directory-total">{directoryResultUnread ? unreadDirectoryLabel : displayedAccountType === "platform" ? `共 ${model.userDirectory.total} 个运营平台账号` : `共 ${model.userDirectory.workspaceCount} 家商家工作区`}</Button></Dropdown>} aria-busy={model.userDirectoryLoading}>
      <Form<UserFilters> form={form} layout="inline" initialValues={{ status: "", accountType: "merchant" }} onFinish={(values) => { setSelectedUserKeys([]); void model.loadUsers({ ...values, status: values.status || undefined, page: 1 }); }} aria-label="用户目录筛选">
        <Form.Item name="query" label="搜索"><Input allowClear disabled={!canReadUserDirectory} maxLength={64} aria-label="按关键词筛选用户目录" style={{ width: 200 }} /></Form.Item>
        <Form.Item name="status" label="状态">
          <Select aria-label="按激活状态筛选用户目录" disabled={!canReadUserDirectory} style={{ width: 140 }} options={[
            { value: "", label: "全部" }, { value: "active", label: "已激活" }, { value: "invited", label: "待激活" }, { value: "suspended", label: "已停用" },
          ]} />
        </Form.Item>
        <Form.Item name="accountType" label="属性">
          <Select aria-label="按账号属性筛选用户目录" disabled={!canReadUserDirectory} style={{ width: 140 }} options={[
            { value: "all", label: "全部" }, { value: "merchant", label: "商家账号" }, { value: "platform", label: "运营平台账号" },
          ]} />
        </Form.Item>
        <Form.Item><Space>
          <Button type="primary" htmlType="submit" disabled={!canReadUserDirectory} loading={model.userDirectoryLoading}>查询</Button>
          <Button htmlType="button" disabled={!canReadUserDirectory || model.userDirectoryLoading} onClick={() => { setSelectedUserKeys([]); form.resetFields(); void model.loadUsers({ accountType: "merchant", page: 1 }); }}>清空筛选</Button>
          <Button danger onClick={() => { setActionError(""); setBulkSuspendOpen(true); }} disabled={!selectedUsers.length}>批量停用（{selectedUsers.length}）</Button>
        </Space></Form.Item>
      </Form>
      <div aria-live="polite" className="ops-visually-hidden">
        {model.userExporting ? "正在生成用户目录导出文件，请稍候" : model.userDirectoryLoading ? "正在加载用户目录，已有结果会保留" : ""}
      </div>
      {model.userDirectoryError && <div ref={directoryErrorRef} tabIndex={-1} role="alert" aria-live="assertive" aria-atomic="true" aria-label="用户目录错误摘要" aria-describedby="user-directory-error-description">
        <Alert
          className="ops-inline-alert"
          showIcon
          type="error"
          title="用户目录加载失败"
          description={<span id="user-directory-error-description">{model.userDirectory.items.length > 0 ? "已保留最近一次成功加载的用户目录；修复连接后可重新拉取最新数据。" : model.userDirectoryError}</span>}
          action={<Button htmlType="button" size="small" style={{ minHeight: 44 }} aria-label="刷新用户目录" disabled={!canReadUserDirectory} onClick={() => void model.loadUsers(form.getFieldsValue())}>刷新用户目录</Button>}
        />
      </div>}
      {model.userDirectoryCompatibilityWarning && <Alert
        className="ops-inline-alert"
        showIcon
        type="warning"
        title="运营 API 兼容模式"
        description={model.userDirectoryCompatibilityWarning}
      />}
      <Table<PlatformUser>
        aria-label="用户目录数据表"
        rowKey={userDirectoryRowKey}
        loading={model.userDirectoryLoading}
        dataSource={model.userDirectory.items}
        rowClassName={(row) => row.status === "suspended" ? "ops-user-row-suspended" : ""}
        locale={{ emptyText: directoryResultUnread ? model.userDirectoryLoading ? unreadDirectoryLabel : "用户目录未读取，请刷新后重试" : displayedAccountType === "platform" ? "没有符合条件的运营平台账号" : "没有符合条件的用户成员关系" }}
        rowSelection={{ selectedRowKeys: selectedUserKeys, onChange: (keys) => setSelectedUserKeys(keys.map((key) => String(key))), getCheckboxProps: (row) => ({ disabled: row.accountType === "platform" || row.externalSubject === model.opsSession?.actor_id || row.status === "suspended" }) }}
        pagination={{ current: Math.floor(model.userDirectory.offset / model.userDirectory.limit) + 1, pageSize: model.userDirectory.limit, total: model.userDirectory.total, showSizeChanger: false }}
        onChange={handleDirectoryChange}
        scroll={{ x: "max-content" }}
        columns={[
          { title: "用户名", dataIndex: "externalSubject", width: 405, render: (value: string) => <Typography.Text className="ops-token ops-token-single-line" copyable>{value}</Typography.Text> },
          { title: "店铺名", dataIndex: "displayName", width: 213, render: (value: string, row: PlatformUser) => value || row.externalSubject },
          { title: "激活状态", dataIndex: "status", width: 130, render: (value: string) => <Tag color={value === "active" ? "green" : value === "suspended" ? "red" : "gold"}>{memberStatusLabels[value] ?? value}</Tag> },
          { title: "用户属性", dataIndex: "accountType", width: 177, render: (value: PlatformUser["accountType"]) => value === "platform" ? "运营平台账号" : "商家账号" },
          { title: "操作", key: "actions", width: 179, render: (_: unknown, row: PlatformUser) => <Space size="small"><Button ref={(node) => { const key = userDirectoryRowKey(row); if (node) detailButtonRefs.current.set(key, node); else detailButtonRefs.current.delete(key); }} size="small" aria-label={`查看 ${row.displayName || row.externalSubject} 的用户详情`} onClick={() => { detailTriggerRowKeyRef.current = userDirectoryRowKey(row); setDetailAccountType(row.accountType ?? "merchant"); setDetailSubject(row.externalSubject); void model.loadUserDetail(row.externalSubject, row.identityId); }}>详情</Button>{row.accountType === "platform" ? <Button size="small" disabled title="平台账号不能停用">停用</Button> : <Button danger={row.status !== "suspended"} size="small" aria-label={`${row.status === "suspended" ? "启用" : "停用"} ${row.displayName || row.externalSubject} 的访问`} title={row.externalSubject === model.opsSession?.actor_id ? "不能停用当前登录账号" : undefined} disabled={!model.canUserGovernance || (row.status !== "suspended" && row.externalSubject === model.opsSession?.actor_id)} onClick={() => { setActionError(""); setAccessTarget(row); }}>{row.status === "suspended" ? "启用" : "停用"}</Button>}</Space> },
        ]}
      />
    </Card>
    <Modal
      title="邀请客户激活登录账号"
      open={provisionOpen}
      okText={provisionUnknown ? "查询原邀请结果" : "创建账号与安全邀请"}
      cancelText="关闭"
      confirmLoading={provisionSubmitting}
      okButtonProps={{ disabled: Boolean(provisionResult) || !model.canPlatformOps }}
      destroyOnHidden
      onCancel={() => { if (!provisionSubmitting) { provisionWorkspaceRequestRef.current += 1; setProvisionWorkspaceQueryApplied(undefined); setProvisionOpen(false); } }}
      onOk={() => void provisionForm.submit()}
    >
      <Alert className="ops-inline-alert" showIcon type="info" title="账号激活与付费开通分别处理" description="客户通过一次性邀请自行设置密码；运营不录入或交付临时密码。本操作不建收款、不授予套餐。代购及真实到账核验请到财务中心“商业订单”。" />
      {provisionError && <Alert className="ops-inline-alert" showIcon type="error" role="alert" title={provisionUnknown ? "邀请结果待确认" : "邀请未完成"} description={provisionError} />}
      {provisionResult && <section aria-live="polite">
        <Alert className="ops-inline-alert" showIcon type="success" title={provisionResult.invitation.status === "activated" ? "客户已激活登录" : "账号与邀请已登记，等待客户激活"} description={`账号：${provisionResult.account.login}；企业：${provisionResult.account.workspaceIds.join("、")}。激活仅开放登录，不代表开通费或套餐已支付。`} />
        <Typography.Paragraph>邀请有效至 {formatKnownDateTime(provisionResult.invitation.expires_at)}。系统没有发送邮件，请核对客户身份后通过安全渠道交付邀请链接。</Typography.Paragraph>
        {provisionResult.invitation.activation_link ? <Typography.Paragraph copyable={{ text: provisionResult.invitation.activation_link }}>一次性激活链接（仅本次显示；点击右侧复制后安全交付客户）</Typography.Paragraph> : provisionResult.invitation.status !== "activated" ? <Alert showIcon type="warning" title="原邀请记录已找到，原始链接不会再次返回" description="重新签发会立即使旧链接失效，不会重复创建账号或企业。" /> : null}
        {provisionResult.invitation.status !== "activated" && <Button loading={provisionSubmitting} disabled={!model.canPlatformOps} onClick={async () => {
          const values = provisionForm.getFieldsValue();
          const payload = { login: provisionResult.account.login, enterprise_name: values.enterpriseName, contact_name: values.contactName,
            workspace_ids: provisionResult.account.workspaceIds, create_workspace: false, reason: values.reason,
            action: "reissue", idempotency_key: `merchant-invite-${crypto.randomUUID()}` };
          provisionIntentRef.current = payload; setProvisionSubmitting(true); setProvisionError("");
          try {
            const result = await opsRestPost<MerchantInvitationView>("/v1/ops/merchant-accounts", payload);
            if (!result) throw new Error("原邀请结果尚未返回，请按原标识查询");
            setProvisionResult(result); setProvisionUnknown(false);
          } catch (error) { setProvisionUnknown(true); setProvisionResult(undefined); setProvisionError(`${describeOpsError(error)}；请沿用原邀请意图查询，勿重新开户。`); }
          finally { setProvisionSubmitting(false); }
        }}>重新签发邀请并使旧链接失效</Button>}
        <Typography.Paragraph>邀请标识：<Typography.Text copyable>{provisionResult.invitation.id}</Typography.Text></Typography.Paragraph>
      </section>}
      <Form form={provisionForm} layout="vertical" requiredMark={false} disabled={provisionSubmitting || provisionUnknown || Boolean(provisionResult)} initialValues={{ workspaceMode: "new" }} onFinish={async (values) => {
        if (!model.canPlatformOps) { setProvisionError("当前身份没有平台运营开户权限。"); return; }
        const payload = provisionUnknown && provisionIntentRef.current ? provisionIntentRef.current : {
          login: values.login.trim(), enterprise_name: values.enterpriseName.trim(), contact_name: values.contactName.trim(),
          workspace_ids: values.workspaceMode === "existing" && values.workspaceId ? [values.workspaceId] : [],
          create_workspace: values.workspaceMode === "new", reason: values.reason.trim(),
          action: "create", idempotency_key: `merchant-invite-${crypto.randomUUID()}`,
        };
        provisionIntentRef.current = payload; setProvisionSubmitting(true); setProvisionError("");
        try {
          const result = await opsRestPost<MerchantInvitationView>("/v1/ops/merchant-accounts", payload);
          if (!result) throw new Error("邀请创建结果未返回，请查询原意图");
          setProvisionResult(result); setProvisionUnknown(false);
          await model.loadUsers({ page: 1 });
        } catch (error) {
          const detail = error as { httpStatus?: number };
          const unknown = !detail.httpStatus || detail.httpStatus >= 500;
          setProvisionUnknown(unknown);
          setProvisionError(`${describeOpsError(error)}${unknown ? "；请查询原邀请结果，不要创建另一账号。" : ""}`);
        } finally { setProvisionSubmitting(false); }
      }}>
        <Form.Item label="商家登录邮箱" name="login" rules={[{ required: true, type: "email", message: "请输入客户本人的邮箱" }]}><Input autoComplete="off" maxLength={128} placeholder="merchant@example.com" /></Form.Item>
        <Form.Item label="企业名称" name="enterpriseName" rules={[{ required: true, whitespace: true, message: "请输入企业名称" }]}><Input maxLength={200} /></Form.Item>
        <Form.Item label="联系人" name="contactName" rules={[{ required: true, whitespace: true, message: "请输入联系人" }]}><Input maxLength={100} /></Form.Item>
        <Form.Item label="企业工作区" name="workspaceMode"><Select options={[{ value: "new", label: "创建新的企业工作区" }, { value: "existing", label: "绑定一个已存在的企业" }]} /></Form.Item>
        {provisionWorkspaceMode === "existing" && <>
          <Form.Item label="搜索企业工作区">
            <Space.Compact style={{ width: "100%" }}>
              <Input aria-label="搜索要绑定的企业工作区" maxLength={200} value={provisionWorkspaceQuery} disabled={model.workspaceDirectoryLoading || provisionSubmitting} placeholder="输入企业名称或 Workspace ID" onChange={event => { setProvisionWorkspaceQuery(event.target.value); setProvisionWorkspaceQueryApplied(undefined); provisionForm.setFieldValue("workspaceId", undefined); }} onPressEnter={event => { event.preventDefault(); const requestId = ++provisionWorkspaceRequestRef.current; setProvisionWorkspaceQueryApplied(undefined); void model.loadWorkspaceDirectory({ query: provisionWorkspaceQuery.trim() || undefined, status: "active", merchantOnly: true, page: 1, pageSize: 100 }).then(ok => { if (requestId === provisionWorkspaceRequestRef.current && ok) setProvisionWorkspaceQueryApplied(provisionWorkspaceQuery.trim()); }); }} />
              <Button aria-label="查询企业工作区" loading={model.workspaceDirectoryLoading} disabled={provisionSubmitting} onClick={() => { const query = provisionWorkspaceQuery.trim(); const requestId = ++provisionWorkspaceRequestRef.current; setProvisionWorkspaceQueryApplied(undefined); provisionForm.setFieldValue("workspaceId", undefined); void model.loadWorkspaceDirectory({ query: query || undefined, status: "active", merchantOnly: true, page: 1, pageSize: 100 }).then(ok => { if (requestId === provisionWorkspaceRequestRef.current && ok) setProvisionWorkspaceQueryApplied(query); }); }}>查询</Button>
            </Space.Compact>
          </Form.Item>
          {model.workspaceDirectoryError && <Alert role="alert" type="error" showIcon title="企业工作区查询失败" description={model.workspaceDirectoryError} />}
          <Form.Item label="目标企业" name="workspaceId" rules={[{ required: true, message: "请选择要绑定的企业" }]}>
            <Select disabled={provisionWorkspaceQueryApplied === undefined || model.workspaceDirectoryLoading} loading={model.workspaceDirectoryLoading} options={provisionWorkspaceQueryApplied === undefined ? [] : (model.workspaceDirectory?.items ?? []).filter(item => item.status === "active").map(item => ({ value: item.workspaceId, label: `${item.enterpriseName || item.workspaceId} · ${item.workspaceId}` }))} placeholder={provisionWorkspaceQueryApplied === undefined ? "先搜索企业名称或 Workspace ID" : "选择已核实企业，服务端会再次验证"} />
          </Form.Item>
          {provisionWorkspaceQueryApplied !== undefined && !model.workspaceDirectoryLoading && !model.workspaceDirectoryError && (model.workspaceDirectory?.items ?? []).filter(item => item.status === "active").length === 0 && <Typography.Text role="status">没有找到匹配的正常企业工作区</Typography.Text>}
          {provisionWorkspaceQueryApplied !== undefined && model.workspaceDirectory?.hasMore && <Button disabled={model.workspaceDirectoryLoading || provisionSubmitting} loading={model.workspaceDirectoryLoading} onClick={() => { const requestId = ++provisionWorkspaceRequestRef.current; setProvisionWorkspaceQueryApplied(undefined); provisionForm.setFieldValue("workspaceId", undefined); void model.loadWorkspaceDirectory({ query: provisionWorkspaceQueryApplied || undefined, status: "active", merchantOnly: true, page: Math.floor(model.workspaceDirectory.offset / model.workspaceDirectory.limit) + 2, pageSize: 100 }).then(ok => { if (requestId === provisionWorkspaceRequestRef.current && ok) setProvisionWorkspaceQueryApplied(provisionWorkspaceQueryApplied); }); }}>下一页企业</Button>}
        </>}
        <Form.Item label="开户或邀请原因" name="reason" rules={[{ required: true, min: 4, message: "请填写不少于4个字符的原因" }]}><Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} maxLength={500} /></Form.Item>
      </Form>
    </Modal>
    <Drawer className="ops-user-detail-drawer" title={detailAccountType === "platform" ? "运营平台用户详情" : "商户用户详情"} aria-label="用户目录详情抽屉" size="min(920px, calc(100vw - 32px))" open={Boolean(detailSubject)} onClose={closeUserDetail} afterOpenChange={(open) => { if (!open) restoreUserDetailFocus(); }} destroyOnHidden footer={detailAccountType === "platform" ? null : (() => {
      const firstMembership = model.userDetail?.memberships[0];
      const actionContext = firstMembership ? membershipAccessActionContext(firstMembership) : undefined;
      return <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <Typography.Text type="secondary">{actionContext ? `目标：${actionContext.target}；当前成员状态：${actionContext.status}` : "没有可操作的工作区成员关系"}</Typography.Text>
        <Button danger={actionContext?.action === "停用"} disabled={!model.canUserGovernance || !firstMembership} aria-label={actionContext?.buttonLabel ?? "没有可操作的工作区成员关系"} onClick={() => { if (firstMembership) { setActionError(""); setAccessTarget(firstMembership); } }}>{actionContext ? `${actionContext.action}成员访问` : "无可操作成员"}</Button>
      </div>;
    })()}>
      <Spin spinning={model.userDetailLoading} tip="正在加载用户详情…" aria-label="正在加载用户详情">
        {!model.userDetailLoading && !model.userDetail ? <Empty description="用户详情尚未取得，请重试或关闭后重新打开" /> : null}
        {model.userDetail && <Space orientation="vertical" size="middle" className="full-width">
          <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }} items={[
            { key: "name", label: "用户名", children: model.userDetail.identity.displayName || model.userDetail.identity.externalSubject },
            { key: "identity", label: "持久身份 ID", children: model.userDetail.identity.id ? <Typography.Text copyable>{model.userDetail.identity.id}</Typography.Text> : "未提供" },
            { key: "first", label: model.userDetail.identity.id ? "身份首次识别时间" : "成员首次记录时间", children: formatKnownDateTime(model.userDetail.identity.firstSeenAt) },
          ]} />
          {detailAccountType === "platform" && <Alert type="info" showIcon title="运营平台账号" description="此账号属于运营平台，不计入商家工作区成员、套餐或商品数据。" />}
          {detailAccountType === "merchant" && <>
          <section className="ops-user-detail-section"><Typography.Title level={5}>成员与工作区</Typography.Title><Table size="small" tableLayout="fixed" scroll={{ x: 760 }} rowKey={(row) => `${row.workspaceId}:${row.externalSubject}`} pagination={false} dataSource={model.userDetail.memberships} columns={[
            { title: "序号", key: "index", align: "center", width: 60, render: (_: unknown, _row: PlatformUser, index: number) => index + 1 },
            { title: "企业主体", key: "name", align: "center", width: 220, render: (_: unknown, row: PlatformUser) => row.enterpriseName || row.workspaceId },
            { title: "工作区状态", key: "status", align: "center", width: 120, render: (_: unknown, row: PlatformUser) => <Tag color={row.workspaceStatus === "active" ? "green" : "default"}>{workspaceStatusLabels[row.workspaceStatus] ?? row.workspaceStatus}</Tag> },
            { title: "成员创建时间", key: "createdAt", align: "center", width: 170, render: (_: unknown, row: PlatformUser) => formatKnownDateTime(row.createdAt) },
            { title: "成员更新时间", dataIndex: "updatedAt", align: "center", width: 170, render: (value: string) => formatKnownDateTime(value) },
          ]} /></section>
          <section className="ops-user-detail-section"><Typography.Title level={5}>旧版套餐与任务额度快照</Typography.Title><Table size="small" tableLayout="fixed" scroll={{ x: 760 }} rowKey={(row) => `${row.workspaceId}:${row.externalSubject}:commercial-snapshot`} pagination={false} dataSource={legacyCommercialSnapshotRows(model.userDetail.memberships)} locale={{ emptyText: "暂无旧版套餐与用量数据" }} columns={[
            { title: "序号", key: "index", align: "center", width: 60, render: (_: unknown, _row: PlatformUser, index: number) => index + 1 },
            { title: "成员", key: "name", align: "left", width: 150, render: (_: unknown, row: PlatformUser) => row.displayName || row.externalSubject },
            { title: "旧版套餐", key: "plan", align: "left", width: 140, render: (_: unknown, row: PlatformUser) => row.commercial?.planName ?? "未提供" },
            { title: "旧版订阅状态", key: "subscription", align: "center", width: 130, render: (_: unknown, row: PlatformUser) => row.commercial?.subscriptionStatus ?? "未提供" },
            { title: "任务额度（已用 / 包含）", key: "tasks", align: "center", width: 180, render: (_: unknown, row: PlatformUser) => row.commercial ? `${row.commercial.usedTasks} / ${row.commercial.includedTasks}` : "未提供" },
            { title: "剩余任务", key: "remaining", align: "center", width: 100, render: (_: unknown, row: PlatformUser) => row.commercial?.remainingTasks ?? "未提供" },
          ]} /></section>
          <Alert type="info" showIcon title="此处仅显示旧版套餐与任务额度快照；当前 V2 套餐及权益请到“订单与权益”核对，实收金额请核对财务流水。" />
          </>}
        </Space>}
      </Spin>
    </Drawer>
    <Modal
      title={accessTarget?.status === "suspended" ? "启用用户访问" : "停用用户访问"} width={420} open={Boolean(accessTarget)} okText={accessTarget?.status === "suspended" ? "确认启用" : "确认停用"}
      okButtonProps={{ danger: accessTarget?.status !== "suspended", disabled: suspendReason.trim().length < 4 }}
      confirmLoading={suspending} transitionName="" maskTransitionName="" onOk={() => void submitAccessChange()}
      onCancel={() => { if (!suspending) { setAccessTarget(undefined); setSuspendReason(""); } }}
    >
      <div className="ops-suspension-dialog">
        {actionError && <div ref={actionErrorRef} className="ops-form-error-summary" role="alert" tabIndex={-1} aria-labelledby="user-access-error-title" aria-describedby="user-access-error-description"><Typography.Text strong id="user-access-error-title">操作未完成</Typography.Text><Typography.Paragraph id="user-access-error-description">{actionError}</Typography.Paragraph></div>}
        <Typography.Paragraph className="ops-suspension-summary">{accessTarget?.status === "suspended" ? "启用" : "停用"} <Typography.Text code>{accessTarget?.displayName || accessTarget?.externalSubject}</Typography.Text> 的所有系统操作权限，不会删除其云端数据。</Typography.Paragraph>
        <Alert showIcon type="info" title="本操作由当前会话授权" description="服务端会根据当前登录身份、租户范围和 identity.update 权限重新校验并记录真实操作人；这里不接受手工填写的“审批人”声明。" />
        <div className="ops-suspension-field">
          <label htmlFor="suspend-reason">操作原因（至少 4 个字符）</label>
          <Input.TextArea id="suspend-reason" aria-describedby={actionError ? "user-access-error-title" : undefined} autoFocus rows={2} maxLength={500} value={suspendReason} onChange={(event) => { setSuspendReason(event.target.value); if (actionError) setActionError(""); }} placeholder="例如：按工单 OPS-123 撤销或恢复访问" />
        </div>
      </div>
    </Modal>
    <Modal title={identityAction === "suspended" ? "全局停用平台身份" : "恢复平台身份"} open={Boolean(identityAction)} okText="确认执行" okButtonProps={{ danger: identityAction === "suspended", disabled: identityWritesDisabled || identityReason.trim().length < 4 }} onCancel={() => { setIdentityAction(undefined); setIdentityReason(""); }} onOk={async () => { if (identityAction && await model.changeIdentityAccess(identityAction, identityReason.trim())) { setIdentityAction(undefined); setIdentityReason(""); } }}>
      <Alert showIcon type={identityAction === "suspended" ? "error" : "warning"} title={identityAction === "suspended" ? "该用户在所有租户的访问将立即失效，活动会话会被撤销。" : "只恢复身份状态；旧会话不会复活，用户必须重新登录。"} />
      <label htmlFor="identity-reason">操作原因（至少 4 个字符）</label><Input.TextArea id="identity-reason" rows={4} value={identityReason} onChange={(event) => setIdentityReason(event.target.value)} />
    </Modal>
    <Modal title="调整身份风险策略" open={Boolean(riskDecision)} okText="保存风险策略" okButtonProps={{ danger: riskDecision === "block", disabled: identityWritesDisabled || identityReason.trim().length < 4 }} onCancel={() => { setRiskDecision(undefined); setIdentityReason(""); }} onOk={async () => { if (riskDecision && await model.transitionIdentityRisk(riskLevel, riskDecision, identityReason.trim())) { setRiskDecision(undefined); setIdentityReason(""); } }}>
      <Space orientation="vertical" className="full-width"><Select value={riskLevel} onChange={setRiskLevel} options={[{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "critical" }]} /><Select value={riskDecision} onChange={setRiskDecision} options={[{ value: "allow", label: "允许" }, { value: "step_up", label: "要求 MFA" }, { value: "block", label: "阻断并撤销会话" }]} /><Input.TextArea aria-label="风险策略原因" rows={4} value={identityReason} onChange={(event) => setIdentityReason(event.target.value)} placeholder="填写风险证据或工单原因" /></Space>
    </Modal>
    <Modal title={`批量停用用户（${selectedUsers.length}）`} open={bulkSuspendOpen} okText="逐条执行停用" cancelText="取消" transitionName="" maskTransitionName="" confirmLoading={bulkSuspending} okButtonProps={{ danger: true, disabled: bulkSuspendReason.trim().length < 4 || !selectedUsers.length }} onCancel={() => { if (!bulkSuspending) { setBulkSuspendOpen(false); setBulkSuspendReason(""); setActionError(""); } }} onOk={() => void submitBulkSuspend()}>
      <Alert showIcon type="warning" title="操作会逐条写入真实成员状态和审计记录" description="系统不会把部分成功伪装成全部成功；失败成员会保留在刷新后的目录中，需要单独处理。当前登录账号和已停用成员不可勾选。" />
      {actionError && <div ref={actionErrorRef} className="ops-form-error-summary" role="alert" tabIndex={-1} aria-labelledby="bulk-suspend-error-title" aria-describedby="bulk-suspend-error-description"><Typography.Text strong id="bulk-suspend-error-title">批量操作结果</Typography.Text><Typography.Paragraph id="bulk-suspend-error-description">{actionError}</Typography.Paragraph></div>}
      <Typography.Paragraph>将停用当前筛选结果中已勾选的 {selectedUsers.length} 个成员关系。</Typography.Paragraph>
      <label htmlFor="bulk-suspend-reason">操作原因（至少 4 个字符）</label>
      <Input.TextArea id="bulk-suspend-reason" aria-describedby={actionError ? "bulk-suspend-error-title" : undefined} autoFocus rows={4} maxLength={500} showCount value={bulkSuspendReason} onChange={(event) => { setBulkSuspendReason(event.target.value); if (actionError) setActionError(""); }} placeholder="填写工单号、风险证据或客户请求" />
    </Modal>
  </>;
}
