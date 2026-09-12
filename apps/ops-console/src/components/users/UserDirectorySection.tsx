import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Card, Col, Descriptions, Drawer, Empty, Form, Input, Modal, Row, Select, Space, Spin, Statistic, Table, Tag, Typography } from "antd";
import type { TableProps } from "antd";
import type { MerchantAccountAuthorizationResult, OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import type { PlatformUser } from "../../types/ops";
import { EnterpriseIdentity } from "../EnterpriseIdentity.js";

type UserFilters = { query?: string; status?: string; workspaceId?: string };
export type UserDirectorySort = { field: "displayName" | "status" | "createdAt"; order: "ascend" | "descend" };
type DirectoryUser = PlatformUser & { createdAt?: string };
const roleLabels: Record<string, string> = { workspace_owner: "企业所有者", merchant_admin: "企业管理员", operator: "运营", support: "支持", finance: "财务", platform_ops: "平台运营" };
const memberStatusLabels: Record<string, string> = { active: "已激活", invited: "待激活", suspended: "已停用" };
const memberStatusOrder: Record<string, number> = { active: 0, invited: 1, suspended: 2 };
const workspaceStatusLabels: Record<string, string> = { active: "正常", disabled: "已停用" };
const lifecycleEventLabels: Record<string, string> = {
  "identity.observed": "身份首次识别",
  "identity.suspended": "全局停用身份",
  "identity.active": "恢复平台身份",
  "identity.risk.transition": "调整风险策略",
  "session.revoked": "撤销认证会话",
};
const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const userNameCollator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

export function compareUserDirectoryRows(left: PlatformUser, right: PlatformUser, field: UserDirectorySort["field"]) {
  const leftRow = left as DirectoryUser;
  const rightRow = right as DirectoryUser;
  let result = 0;
  if (field === "displayName") result = userNameCollator.compare(left.displayName || left.externalSubject, right.displayName || right.externalSubject);
  if (field === "status") result = (memberStatusOrder[left.status] ?? Number.MAX_SAFE_INTEGER) - (memberStatusOrder[right.status] ?? Number.MAX_SAFE_INTEGER);
  if (field === "createdAt") result = (Date.parse(leftRow.createdAt ?? "") || 0) - (Date.parse(rightRow.createdAt ?? "") || 0);
  return result || userNameCollator.compare(`${left.workspaceId}:${left.externalSubject}`, `${right.workspaceId}:${right.externalSubject}`);
}

export function sortUserDirectoryRows(items: PlatformUser[], sort?: UserDirectorySort) {
  if (!sort) return items;
  const direction = sort.order === "ascend" ? 1 : -1;
  return [...items].sort((left, right) => direction * compareUserDirectoryRows(left, right, sort.field));
}

export function userDirectoryPageRequest(filters: UserFilters, current?: number, pageSize?: number) {
  return { ...filters, page: current ?? 1, pageSize: pageSize ?? 20 };
}

export function canWriteLoadedIdentity(model: Pick<OpsConsoleModel, "canUserGovernance" | "userDetail" | "userDetailLoading">) {
  return model.canUserGovernance && !model.userDetailLoading && Boolean(model.userDetail?.identity.id);
}

export function UserDirectorySection({ model }: { model: OpsConsoleModel }) {
  const canReadUserDirectory = model.authorization.can("identity.read");
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
  const [selectedUserKeys, setSelectedUserKeys] = useState<string[]>([]);
  const [bulkSuspendOpen, setBulkSuspendOpen] = useState(false);
  const [bulkSuspendReason, setBulkSuspendReason] = useState("");
  const [bulkSuspending, setBulkSuspending] = useState(false);
  const [provisionOpen, setProvisionOpen] = useState(false);
  const [provisionSubmitting, setProvisionSubmitting] = useState(false);
  const [provisionResult, setProvisionResult] = useState<{ login: string; onboardingFeeFen: number; authorization?: MerchantAccountAuthorizationResult }>();
  const [provisionForm] = Form.useForm<{ login: string; password: string; enterpriseName: string; contactName: string; workspaceIds: string; reason: string; skuCode: string; amountFen: number; paymentStatus: "pending" | "verified"; paymentReference?: string; paidAt?: string }>();
  const [actionError, setActionError] = useState("");
  const actionErrorRef = useRef<HTMLDivElement>(null);
  const directoryErrorRef = useRef<HTMLDivElement>(null);
  const [userSort, setUserSort] = useState<UserDirectorySort>();
  const detailTriggerSubjectRef = useRef<string | undefined>(undefined);
  const detailButtonRefs = useRef(new Map<string, HTMLElement>());
  const sortedUsers = useMemo(() => sortUserDirectoryRows(model.userDirectory.items, userSort), [model.userDirectory.items, userSort]);
  const identityWritesDisabled = !canWriteLoadedIdentity(model);
  const initialDirectoryLoadFailed = Boolean(model.userDirectoryError && !model.userDirectoryLoading && model.userDirectory.items.length === 0);

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
    model.setUserDetail(undefined);
  };
  const restoreUserDetailFocus = () => {
    const triggerSubject = detailTriggerSubjectRef.current;
    detailTriggerSubjectRef.current = undefined;
    if (triggerSubject) {
      const focusTrigger = () => {
        const trigger = detailButtonRefs.current.get(triggerSubject);
        if (!trigger) return;
        trigger.focus({ preventScroll: true });
        if (document.activeElement === trigger) detailTriggerSubjectRef.current = undefined;
      };
      window.requestAnimationFrame(() => window.setTimeout(focusTrigger, 120));
    }
  };
  useEffect(() => {
    // With destroyOnHidden, Drawer may finish its close transition before the
    // table row has been committed again. Retry from the post-state commit so
    // keyboard users reliably return to the control that opened the drawer.
    if (detailSubject !== undefined || !detailTriggerSubjectRef.current) return;
    restoreUserDetailFocus();
  }, [detailSubject]);
  const selectedUsers = model.userDirectory.items
    .filter((row) => selectedUserKeys.includes(`${row.accountType ?? "merchant"}:${row.workspaceId}:${row.externalSubject}`))
    .map((row) => ({ workspaceId: row.workspaceId, externalSubject: row.externalSubject, revision: row.revision }));
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
    } else setActionError(`已完成 ${selectedUsers.length - result.failed} 个，${result.failed} 个未完成。请保留当前选择并逐条重试失败项。`);
  };
  const handleDirectoryChange: TableProps<PlatformUser>["onChange"] = (pagination, _filters, sorter, extra) => {
    if (extra.action === "sort") {
      const activeSorter = Array.isArray(sorter) ? sorter[0] : sorter;
      const field = activeSorter?.field;
      const order = activeSorter?.order;
      if ((field === "displayName" || field === "status" || field === "createdAt") && (order === "ascend" || order === "descend")) {
        setUserSort({ field, order });
      } else {
        setUserSort(undefined);
      }
      return;
    }
    void model.loadUsers(userDirectoryPageRequest(form.getFieldsValue(), pagination.current, pagination.pageSize));
  };

  return <>
    {!canReadUserDirectory && <Alert showIcon type="warning" title="当前角色不能读取用户目录" description="跨租户身份与成员关系需要 identity.read；权限由服务端策略决定。" />}
    {canReadUserDirectory && !model.canUserGovernance && <Alert showIcon type="info" title="当前为只读视图" description="可以查询身份、成员关系和审计详情，但停用、恢复、风险策略与会话撤销需要 identity.update。" />}
    <Row gutter={[16, 16]}>
      <Col xs={24} md={8}><Card><Statistic title="用户身份" value={model.userDirectory.identityCount} /></Card></Col>
      <Col xs={24} md={8}><Card><Statistic title="成员关系" value={model.userDirectory.total} /></Card></Col>
      <Col xs={24} md={8}><Card><Statistic title="涉及企业主体" value={model.userDirectory.workspaceCount} /></Card></Col>
    </Row>
          <Alert
      showIcon
      type="info"
      title="用户、成员关系与企业主体的关系"
      description="用户是一个可认证的平台身份；身份标识是认证系统返回的登录主体，不等于姓名。成员关系表示该用户在某个企业主体中的角色和状态。企业名称是主要识别信息，Workspace ID 仅作为技术范围标识保留。同一个用户可以属于多个企业主体，因此目录中的一行代表一条“用户 × 企业主体”成员关系。品牌信息在企业详情或品牌列中单独展示。"
    />
    <Card title="用户目录" aria-busy={model.userDirectoryLoading}>
      <Form<UserFilters> form={form} layout="inline" onFinish={(values) => void model.loadUsers({ ...values, page: 1 })} aria-label="用户目录筛选">
        <Form.Item name="query" label="关键词"><Input allowClear aria-label="按关键词筛选用户目录" placeholder="身份、姓名、角色、企业名称或 Workspace ID" /></Form.Item>
        <Form.Item name="status" label="状态">
          <Select allowClear aria-label="按成员状态筛选用户目录" placeholder="全部状态" style={{ width: 140 }} options={[
            { value: "active", label: "已激活" }, { value: "invited", label: "待激活" }, { value: "suspended", label: "已停用" },
          ]} />
        </Form.Item>
        <Form.Item name="workspaceId" label="企业主体"><Input allowClear aria-label="按企业主体筛选用户目录" placeholder="企业名称或 Workspace ID" /></Form.Item>
        <Form.Item><Space>
          <Button type="primary" htmlType="submit" loading={model.userDirectoryLoading}>查询</Button>
          <Button onClick={() => { form.resetFields(); void model.loadUsers({ page: 1 }); }}>清空</Button>
          <Button
            onClick={() => void model.exportUsers(form.getFieldsValue())}
            disabled={!model.canUserGovernance || model.userExporting}
            loading={model.userExporting}
            aria-busy={model.userExporting}
          >{model.userExporting ? "正在导出" : "导出当前筛选"}</Button>
          <Button
            onClick={() => {
              setActionError("");
              setProvisionResult(undefined);
              provisionForm.resetFields();
              setProvisionOpen(true);
            }}
            disabled={!model.canPlatformOps}
          >开通商家账号</Button>
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
          action={<Button htmlType="button" size="small" style={{ minHeight: 44 }} aria-label="刷新用户目录" onClick={() => void model.loadUsers(form.getFieldsValue())}>刷新用户目录</Button>}
        />
      </div>}
      {model.userDirectory.truncated && <Alert className="ops-inline-alert" showIcon type="info" title="结果超过 500 条，请增加筛选条件。" />}
      <Table<PlatformUser>
        aria-label="用户目录数据表"
        rowKey={(row) => `${row.accountType ?? "merchant"}:${row.workspaceId}:${row.externalSubject}`}
        loading={model.userDirectoryLoading}
        dataSource={sortedUsers}
        locale={{ emptyText: "没有符合条件的用户成员关系" }}
        rowSelection={{ selectedRowKeys: selectedUserKeys, onChange: (keys) => setSelectedUserKeys(keys.map((key) => String(key))), getCheckboxProps: (row) => ({ disabled: row.accountType === "platform" || row.externalSubject === model.opsSession?.actor_id || row.status === "suspended" }) }}
        pagination={{ current: Math.floor(model.userDirectory.offset / model.userDirectory.limit) + 1, pageSize: model.userDirectory.limit, total: model.userDirectory.total, showSizeChanger: true, showTotal: (total) => `共 ${total} 条成员关系` }}
        onChange={handleDirectoryChange}
        scroll={{ x: "max-content" }}
        columns={[
          { title: "登录身份", dataIndex: "externalSubject", width: 220, render: (value: string) => <Typography.Text className="ops-token" copyable>{value}</Typography.Text> },
          { title: "用户显示名", dataIndex: "displayName", width: 150, sorter: true, sortOrder: userSort?.field === "displayName" ? userSort.order : null, render: (value: string) => value || "未设置" },
          { title: "企业主体", key: "scope", width: 240, render: (_: unknown, row: PlatformUser) => row.scope === "platform" ? <Tag color="purple">平台级</Tag> : <EnterpriseIdentity name={row.enterpriseName} workspaceId={row.workspaceId} /> },
          { title: "角色", dataIndex: "role", width: 140, render: (value: string) => <Tag color="blue">{roleLabels[value] ?? value}</Tag> },
          { title: "账号类型", key: "accountType", width: 140, render: (_: unknown, row: PlatformUser) => row.accountType === "platform" ? <Tag color="purple">平台运营账号</Tag> : row.invitedBy === "local_compose_seed" ? <Tag color="gold">商家演示成员</Tag> : <Tag color="green">商家成员</Tag> },
          { title: "套餐 / 消耗", key: "commercial", width: 180, render: (_: unknown, row: PlatformUser) => row.commercial ? <Space orientation="vertical" size={0}><Typography.Text>{row.commercial.planName} · {row.commercial.subscriptionStatus}</Typography.Text><Typography.Text type="secondary">任务 {row.commercial.usedTasks}/{row.commercial.includedTasks} · 余额 ¥{row.commercial.walletBalanceCny}</Typography.Text></Space> : <Typography.Text type="secondary">暂无账务快照</Typography.Text> },
          { title: "成员状态", dataIndex: "status", width: 110, sorter: true, sortOrder: userSort?.field === "status" ? userSort.order : null, render: (value: string) => <Tag color={value === "active" ? "green" : value === "suspended" ? "red" : "gold"}>{memberStatusLabels[value] ?? value}</Tag> },
          { title: "企业状态", dataIndex: "workspaceStatus", width: 110, render: (value: string) => <Tag color={value === "active" ? "green" : "default"}>{workspaceStatusLabels[value] ?? value}</Tag> },
          { title: "创建时间", dataIndex: "createdAt", width: 180, sorter: true, sortOrder: userSort?.field === "createdAt" ? userSort.order : null, render: (value?: string) => value ? dateTimeFormatter.format(new Date(value)) : "—" },
          { title: "操作", key: "actions", width: 170, render: (_: unknown, row: PlatformUser) => <Space size="small"><Button ref={(node) => { if (node) detailButtonRefs.current.set(row.externalSubject, node); else detailButtonRefs.current.delete(row.externalSubject); }} size="small" aria-label={`查看 ${row.displayName || row.externalSubject} 的用户详情`} onClick={() => { detailTriggerSubjectRef.current = row.externalSubject; setDetailSubject(row.externalSubject); void model.loadUserDetail(row.externalSubject, row.identityId); }}>详情</Button>{row.accountType === "platform" ? <Tag color="purple">由平台身份治理</Tag> : <Button danger={row.status !== "suspended"} size="small" aria-label={`${row.status === "suspended" ? "恢复" : "停用"} ${row.displayName || row.externalSubject} 的访问`} title={row.externalSubject === model.opsSession?.actor_id ? "不能停用当前登录账号" : undefined} disabled={!model.canUserGovernance || (row.status !== "suspended" && row.externalSubject === model.opsSession?.actor_id)} onClick={() => { setActionError(""); setAccessTarget(row); }}>{row.status === "suspended" ? "恢复" : "停用"}</Button>}</Space> },
        ]}
      />
    </Card>
    <Modal
      title="平台开通商家账号"
      open={provisionOpen}
      okText="开通账号"
      cancelText="取消"
      confirmLoading={provisionSubmitting}
      okButtonProps={{ disabled: Boolean(provisionResult) }}
      destroyOnHidden
      onCancel={() => {
        if (!provisionSubmitting) setProvisionOpen(false);
      }}
      onOk={() => void provisionForm.submit()}
    >
      <Alert
        className="ops-inline-alert"
        showIcon
        type="warning"
        title="开通账号不会自动确认收款"
        description="系统会记录 ¥5,000 正式接入费为待核验状态；支付、合同、权益授予和收入确认仍需要独立审计事件。"
      />
      {provisionResult ? (
        <Alert
          className="ops-inline-alert"
          showIcon
          type="success"
          title="账号已开通"
            description={<Space orientation="vertical" size={4}><span>商家账号 {provisionResult.login} 已创建；接入费 ¥{(provisionResult.onboardingFeeFen / 100).toLocaleString("zh-CN")}。</span>{provisionResult.authorization ? <span>授权状态：{provisionResult.authorization.entitlement_status === "granted" ? "已开通商家全量权限" : "待收款核验"}；权限数量：{provisionResult.authorization.capabilities.length}；支付状态：{provisionResult.authorization.payment_status === "verified" ? "已核验" : "待核验"}。</span> : null}<span>请把临时密码通过安全渠道交付给客户，系统不会再次展示。</span></Space>}
        />
      ) : null}
      <Form
        form={provisionForm}
        layout="vertical"
        requiredMark={false}
        onFinish={async (values) => {
          setProvisionSubmitting(true);
          setProvisionResult(undefined);
          const result = await model.provisionMerchantAccount({
            login: values.login,
            password: values.password,
            enterpriseName: values.enterpriseName,
            contactName: values.contactName,
            workspaceIds: values.workspaceIds.split(/[\s,，]+/u),
            reason: values.reason,
          });
          if (result) {
            const workspaceId = values.workspaceIds.split(/[\s,，]+/u).map((value: string) => value.trim()).filter(Boolean)[0] ?? "";
            const authorization = await model.authorizeMerchantAccount({
              login: result.account.login,
              workspaceId,
              memberRole: "merchant_admin",
              skuCode: values.skuCode,
              amountFen: Number(values.amountFen),
              paymentStatus: values.paymentStatus,
              paymentReference: values.paymentReference,
              paidAt: values.paidAt,
              reason: values.reason,
              idempotencyKey: `merchant-authorize-${result.account.id}`,
            });
            setProvisionResult({ login: result.account.login, onboardingFeeFen: result.onboarding_fee_fen, authorization: authorization ?? undefined });
            provisionForm.resetFields(["password"]);
          }
          setProvisionSubmitting(false);
        }}
      >
        <Form.Item label="商家登录账号" name="login" rules={[{ required: true, type: "email", message: "请输入邮箱格式的商家账号" }]}>
          <Input autoComplete="username" placeholder="merchant@example.com" />
        </Form.Item>
        <Form.Item label="临时密码" name="password" rules={[{ required: true, message: "请输入临时密码" }, { min: 12, message: "临时密码至少 12 位" }]}>
          <Input.Password autoComplete="new-password" placeholder="只在本次开通时录入，不会再次回显" />
        </Form.Item>
        <Form.Item label="企业名称" name="enterpriseName" rules={[{ required: true, whitespace: true, message: "请输入企业名称" }]}>
          <Input placeholder="客户企业名称" />
        </Form.Item>
        <Form.Item label="联系人" name="contactName" rules={[{ required: true, whitespace: true, message: "请输入联系人" }]}>
          <Input placeholder="客户联系人" />
        </Form.Item>
        <Form.Item label="绑定工作区 ID" name="workspaceIds" rules={[{ required: true, whitespace: true, message: "至少填写一个工作区 ID" }]}>
          <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} placeholder="多个工作区用逗号或换行分隔" />
        </Form.Item>
        <Form.Item label="开通原因" name="reason" rules={[{ required: true, min: 4, message: "请填写不少于 4 个字符的开通原因" }]}>
          <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} placeholder="例如：合同已签，等待财务核验首期接入费" />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}><Form.Item label="套餐 SKU" name="skuCode" initialValue="sku-onboarding-5000" rules={[{ required: true, message: "请输入套餐 SKU" }]}><Input placeholder="sku-onboarding-5000" /></Form.Item></Col>
          <Col span={12}><Form.Item label="实收金额（分）" name="amountFen" initialValue={500000} rules={[{ required: true, message: "请输入实收金额" }]}><Input type="number" min={0} /></Form.Item></Col>
          <Col span={12}><Form.Item label="收款状态" name="paymentStatus" initialValue="pending" rules={[{ required: true }]}><Select options={[{ value: "pending", label: "待核验（不开放权限）" }, { value: "verified", label: "已核验（立即开通）" }]} /></Form.Item></Col>
          <Col span={12}><Form.Item label="支付凭证号" name="paymentReference"><Input placeholder="微信/支付宝交易号" /></Form.Item></Col>
          <Col span={24}><Form.Item label="支付时间（ISO UTC）" name="paidAt"><Input placeholder="已核验时必填，例如 2026-09-10T12:00:00.000Z" /></Form.Item></Col>
        </Row>
      </Form>
    </Modal>
    <Drawer title={`用户详情 · ${detailSubject ?? ""}`} aria-label="用户目录详情抽屉" size="large" open={Boolean(detailSubject)} onClose={closeUserDetail} afterOpenChange={(open) => { if (!open) restoreUserDetailFocus(); }} destroyOnHidden>
      <Spin spinning={model.userDetailLoading} tip="正在加载用户详情…" aria-label="正在加载用户详情">
        {!model.userDetailLoading && !model.userDetail ? <Empty description="用户详情尚未取得，请重试或关闭后重新打开" /> : null}
        {model.userDetail && <Space orientation="vertical" size="large" className="full-width">
          <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }} items={[
            { key: "subject", label: "登录身份", children: <Typography.Text className="ops-token" copyable>{model.userDetail.identity.externalSubject}</Typography.Text> },
            { key: "name", label: "用户显示名", children: model.userDetail.identity.displayName || "未设置" },
            { key: "members", label: "成员关系", children: `${model.userDetail.identity.activeMembershipCount} 个有效 / ${model.userDetail.identity.membershipCount} 个总计` },
            { key: "first", label: "首次出现", children: dateTimeFormatter.format(new Date(model.userDetail.identity.firstSeenAt)) },
            { key: "updated", label: "最近更新", children: dateTimeFormatter.format(new Date(model.userDetail.identity.lastUpdatedAt)) },
            { key: "access", label: "平台身份状态", children: model.userDetail.identity.accessStatus ? <Tag color={model.userDetail.identity.accessStatus === "active" ? "green" : "red"}>{model.userDetail.identity.accessStatus === "active" ? "正常" : "全局停用"}</Tag> : "尚未绑定持久身份" },
            { key: "risk", label: "风险策略", children: model.userDetail.identity.riskDecision ? <Tag color={model.userDetail.identity.riskDecision === "allow" ? "green" : model.userDetail.identity.riskDecision === "step_up" ? "gold" : "red"}>{model.userDetail.identity.riskLevel} / {model.userDetail.identity.riskDecision}</Tag> : "—" },
          ]} />
          {model.userDetail.identity.id ? <Alert showIcon type="warning" title="平台身份操作会影响所有租户" description={<Space wrap><Button aria-label={`${model.userDetail.identity.accessStatus === "active" ? "全局停用并撤销会话" : "恢复平台身份"} ${model.userDetail.identity.externalSubject}`} disabled={identityWritesDisabled} danger={model.userDetail.identity.accessStatus === "active"} onClick={() => setIdentityAction(model.userDetail!.identity.accessStatus === "active" ? "suspended" : "active")}>{model.userDetail.identity.accessStatus === "active" ? "全局停用并撤销会话" : "恢复平台身份"}</Button><Button aria-label={`调整 ${model.userDetail.identity.externalSubject} 的风险策略`} disabled={identityWritesDisabled} onClick={() => { setRiskLevel(model.userDetail!.identity.riskLevel ?? "low"); setRiskDecision(model.userDetail!.identity.riskDecision ?? "allow"); }}>调整风险策略</Button></Space>} /> : <Alert showIcon type="info" title="该成员尚未绑定持久平台身份" description="用户下次通过严格认证登录后，系统会绑定身份和会话；当前只能治理单个工作区成员关系。" />}
          <div><Typography.Title level={5}>认证会话（已脱敏）</Typography.Title><Table size="small" rowKey="id" pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => `共 ${total} 条` }} locale={{ emptyText: "暂无认证会话；用户完成严格认证后会在此留痕" }} scroll={{ x: 1080 }} dataSource={model.userDetail.sessions} columns={[
            { title: "类型", dataIndex: "sessionKind", width: 100 },
            { title: "状态", dataIndex: "status", width: 100, render: (value: string) => <Tag color={value === "active" ? "green" : value === "revoked" ? "red" : "default"}>{({ active: "有效", revoked: "已撤销", expired: "已过期" } as Record<string, string>)[value] ?? value}</Tag> },
            { title: "MFA", dataIndex: "mfaVerified", width: 80, render: (value: boolean) => value ? "已验证" : "否" },
            { title: "签发时间", dataIndex: "issuedAt", width: 180, render: (value: string) => dateTimeFormatter.format(new Date(value)) },
            { title: "过期时间", dataIndex: "expiresAt", width: 180, render: (value?: string) => value ? dateTimeFormatter.format(new Date(value)) : "未提供" },
            { title: "最后访问", dataIndex: "lastSeenAt", width: 180, render: (value: string) => dateTimeFormatter.format(new Date(value)) },
            { title: "操作", key: "action", width: 110, render: (_: unknown, row: { id: string; revision: number; status: string }) => <Button danger size="small" aria-label={`撤销认证会话 ${row.id}`} disabled={identityWritesDisabled || row.status !== "active"} onClick={() => setSessionTarget({ id: row.id, revision: row.revision })}>撤销</Button> },
          ]} /></div>
          <div><Typography.Title level={5}>平台身份生命周期</Typography.Title><Table size="small" rowKey="id" pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => `共 ${total} 条` }} locale={{ emptyText: "暂无平台身份生命周期事件" }} scroll={{ x: 780 }} dataSource={model.userDetail.lifecycleEvents} columns={[
            { title: "时间", dataIndex: "createdAt", width: 180, render: (value: string) => dateTimeFormatter.format(new Date(value)) },
            { title: "事件", dataIndex: "eventType", width: 180, render: (value: string) => lifecycleEventLabels[value] ?? value },
            { title: "操作者", dataIndex: "actorId", width: 160, render: (value: string) => value || "系统" },
            { title: "原因与证据", dataIndex: "reason", width: 260, render: (value: string) => value || "系统观测" },
          ]} /></div>
          <div><Typography.Title level={5}>所属租户与角色（企业主体）</Typography.Title><Table size="small" rowKey={(row) => `${row.workspaceId}:${row.externalSubject}`} pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => `共 ${total} 条` }} scroll={{ x: 620 }} dataSource={model.userDetail.memberships} columns={[
            { title: "企业主体", key: "enterprise", width: 220, render: (_: unknown, row: PlatformUser) => <EnterpriseIdentity name={row.enterpriseName} workspaceId={row.workspaceId} /> },
            { title: "角色", dataIndex: "role", width: 140, render: (value: string) => roleLabels[value] ?? value },
            { title: "成员状态", dataIndex: "status", width: 110, render: (value: string) => memberStatusLabels[value] ?? value },
            { title: "企业状态", dataIndex: "workspaceStatus", width: 110, render: (value: string) => workspaceStatusLabels[value] ?? value },
          ]} /></div>
          <div><Typography.Title level={5}>商业、钱包与任务状态</Typography.Title><Table size="small" rowKey={(row) => `${row.workspaceId}:${row.externalSubject}:commercial`} pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => `共 ${total} 条` }} scroll={{ x: 920 }} dataSource={model.userDetail.memberships} locale={{ emptyText: "暂无商业快照；不会把缺失账务数据解释为余额为零" }} columns={[
            { title: "企业主体", key: "enterprise", width: 220, render: (_: unknown, row: PlatformUser) => <EnterpriseIdentity name={row.enterpriseName} workspaceId={row.workspaceId} /> },
            { title: "套餐", width: 160, render: (_: unknown, row: PlatformUser) => row.commercial?.planName ?? "未配置" },
            { title: "订阅 / 权益", width: 150, render: (_: unknown, row: PlatformUser) => row.commercial?.subscriptionStatus ?? "未确认" },
            { title: "任务用量", width: 130, render: (_: unknown, row: PlatformUser) => row.commercial ? `${row.commercial.usedTasks} / ${row.commercial.includedTasks}` : "未确认" },
            { title: "钱包余额", width: 130, render: (_: unknown, row: PlatformUser) => row.commercial ? `¥${row.commercial.walletBalanceCny}` : "未确认" },
            { title: "扣款与账单", width: 200, render: (_: unknown, row: PlatformUser) => row.commercial ? <Tag color={row.commercial.subscriptionStatus === "active" ? "blue" : "gold"}>{row.commercial.subscriptionStatus === "active" ? "订阅有效，账务仍需门禁核验" : "需核对订单/账单"}</Tag> : <Tag>未取得账务快照</Tag> },
          ]} /></div>
          <div><Typography.Title level={5}>成员操作历史</Typography.Title><Table size="small" rowKey="id" pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => `共 ${total} 条` }} locale={{ emptyText: "暂无成员操作记录" }} scroll={{ x: 680 }} dataSource={model.userDetail.audits} columns={[
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
      confirmLoading={suspending} transitionName="" maskTransitionName="" onOk={() => void submitAccessChange()}
      onCancel={() => { if (!suspending) { setAccessTarget(undefined); setSuspendReason(""); } }}
    >
      {actionError && <div ref={actionErrorRef} className="ops-form-error-summary" role="alert" tabIndex={-1} aria-labelledby="user-access-error-title" aria-describedby="user-access-error-description"><Typography.Text strong id="user-access-error-title">操作未完成</Typography.Text><Typography.Paragraph id="user-access-error-description">{actionError}</Typography.Paragraph></div>}
      <Typography.Paragraph>{accessTarget?.status === "suspended" ? "恢复" : "仅停用"} <Typography.Text code>{accessTarget?.externalSubject}</Typography.Text> 在企业主体 <Typography.Text code>{accessTarget?.workspaceId}</Typography.Text> 的访问，不会删除业务数据。</Typography.Paragraph>
      <label htmlFor="suspend-reason">操作原因（至少 4 个字符）</label>
      <Input.TextArea id="suspend-reason" aria-describedby={actionError ? "user-access-error-title" : undefined} autoFocus rows={4} maxLength={500} showCount value={suspendReason} onChange={(event) => { setSuspendReason(event.target.value); if (actionError) setActionError(""); }} placeholder="例如：按工单 OPS-123 撤销或恢复访问" />
    </Modal>
    <Modal title={identityAction === "suspended" ? "全局停用平台身份" : "恢复平台身份"} open={Boolean(identityAction)} okText="确认执行" okButtonProps={{ danger: identityAction === "suspended", disabled: identityWritesDisabled || identityReason.trim().length < 4 }} onCancel={() => { setIdentityAction(undefined); setIdentityReason(""); }} onOk={async () => { if (identityAction && await model.changeIdentityAccess(identityAction, identityReason.trim())) { setIdentityAction(undefined); setIdentityReason(""); } }}>
      <Alert showIcon type={identityAction === "suspended" ? "error" : "warning"} title={identityAction === "suspended" ? "该用户在所有租户的访问将立即失效，活动会话会被撤销。" : "只恢复身份状态；旧会话不会复活，用户必须重新登录。"} />
      <label htmlFor="identity-reason">操作原因（至少 4 个字符）</label><Input.TextArea id="identity-reason" rows={4} value={identityReason} onChange={(event) => setIdentityReason(event.target.value)} />
    </Modal>
    <Modal title="调整身份风险策略" open={Boolean(riskDecision)} okText="保存风险策略" okButtonProps={{ danger: riskDecision === "block", disabled: identityWritesDisabled || identityReason.trim().length < 4 }} onCancel={() => { setRiskDecision(undefined); setIdentityReason(""); }} onOk={async () => { if (riskDecision && await model.transitionIdentityRisk(riskLevel, riskDecision, identityReason.trim())) { setRiskDecision(undefined); setIdentityReason(""); } }}>
      <Space orientation="vertical" className="full-width"><Select value={riskLevel} onChange={setRiskLevel} options={[{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "critical" }]} /><Select value={riskDecision} onChange={setRiskDecision} options={[{ value: "allow", label: "允许" }, { value: "step_up", label: "要求 MFA" }, { value: "block", label: "阻断并撤销会话" }]} /><Input.TextArea aria-label="风险策略原因" rows={4} value={identityReason} onChange={(event) => setIdentityReason(event.target.value)} placeholder="填写风险证据或工单原因" /></Space>
    </Modal>
    <Modal title="撤销认证会话" open={Boolean(sessionTarget)} okText="确认撤销" okButtonProps={{ danger: true, disabled: identityWritesDisabled || sessionReason.trim().length < 4 }} onCancel={() => { setSessionTarget(undefined); setSessionReason(""); }} onOk={async () => { if (sessionTarget && await model.revokeIdentitySession(sessionTarget.id, sessionTarget.revision, sessionReason.trim())) { setSessionTarget(undefined); setSessionReason(""); } }}><Input.TextArea aria-label="会话撤销原因" rows={4} value={sessionReason} onChange={(event) => setSessionReason(event.target.value)} placeholder="填写会话撤销原因或工单号" /></Modal>
    <Modal title={`批量停用用户（${selectedUsers.length}）`} open={bulkSuspendOpen} okText="逐条执行停用" cancelText="取消" transitionName="" maskTransitionName="" confirmLoading={bulkSuspending} okButtonProps={{ danger: true, disabled: bulkSuspendReason.trim().length < 4 || !selectedUsers.length }} onCancel={() => { if (!bulkSuspending) { setBulkSuspendOpen(false); setBulkSuspendReason(""); setActionError(""); } }} onOk={() => void submitBulkSuspend()}>
      <Alert showIcon type="warning" title="操作会逐条写入真实成员状态和审计记录" description="系统不会把部分成功伪装成全部成功；失败成员会保留在刷新后的目录中，需要单独处理。当前登录账号和已停用成员不可勾选。" />
      {actionError && <div ref={actionErrorRef} className="ops-form-error-summary" role="alert" tabIndex={-1} aria-labelledby="bulk-suspend-error-title" aria-describedby="bulk-suspend-error-description"><Typography.Text strong id="bulk-suspend-error-title">批量操作结果</Typography.Text><Typography.Paragraph id="bulk-suspend-error-description">{actionError}</Typography.Paragraph></div>}
      <Typography.Paragraph>将停用当前筛选结果中已勾选的 {selectedUsers.length} 个成员关系。</Typography.Paragraph>
      <label htmlFor="bulk-suspend-reason">操作原因（至少 4 个字符）</label>
      <Input.TextArea id="bulk-suspend-reason" aria-describedby={actionError ? "bulk-suspend-error-title" : undefined} autoFocus rows={4} maxLength={500} showCount value={bulkSuspendReason} onChange={(event) => { setBulkSuspendReason(event.target.value); if (actionError) setActionError(""); }} placeholder="填写工单号、风险证据或客户请求" />
    </Modal>
  </>;
}
