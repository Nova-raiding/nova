import { Alert, Button, Input, Modal, Select, Space, Typography } from "antd";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { useState } from "react";
import { managedOpsSession } from "../api/opsClient";
import { OpsPage } from "../components/OpsPage";
import { FeatureFlagAuditDrawer } from "../components/feature-flags/FeatureFlagAuditDrawer";
import { FeatureFlagEditor, LOCAL_FEATURE_FLAG_ENVIRONMENTS, MANAGED_FEATURE_FLAG_ENVIRONMENTS, featureFlagEnvironmentOptions } from "../components/feature-flags/FeatureFlagEditor";
import { FeatureFlagsTable } from "../components/feature-flags/FeatureFlagsTable";
import { useFeatureFlags, type FeatureFlagsClient } from "../hooks/useFeatureFlags";
import type { FeatureFlag } from "../../../../packages/contracts/src/ops/feature-flags.js";

interface Props { client: FeatureFlagsClient; canWrite: boolean; canEmergency: boolean }

export function featureFlagPermissionNotice(canWrite: boolean, canEmergency: boolean) {
  if (canWrite && canEmergency) return undefined;
  if (!canWrite && !canEmergency) return "当前仅可查看功能开关；服务端未授予 feature_flag.update 或 feature_flag.emergency 能力。";
  if (!canWrite) return "当前仅可查看功能开关；服务端未授予 feature_flag.update 能力。";
  return "当前可执行日常编辑；服务端未授予 feature_flag.emergency 能力，紧急操作不可用。";
}

export function getFeatureFlagEnvironmentConfig(managedSession: boolean) {
  return managedSession
    ? { defaultEnvironment: "production", environments: MANAGED_FEATURE_FLAG_ENVIRONMENTS }
    : { defaultEnvironment: "local_demo", environments: LOCAL_FEATURE_FLAG_ENVIRONMENTS };
}

export function FeatureFlagsPage({ client, canWrite, canEmergency }: Props) {
  const environmentConfig = getFeatureFlagEnvironmentConfig(managedOpsSession);
  const model = useFeatureFlags(client, { environment: environmentConfig.defaultEnvironment });
  const [editing, setEditing] = useState<FeatureFlag | "new">(); const [audit, setAudit] = useState<FeatureFlag>(); const [emergencyTarget, setEmergencyTarget] = useState<FeatureFlag>(); const [emergencyReason, setEmergencyReason] = useState("");
  const initialLoadFailed = Boolean(model.error && !model.loading && model.items.length === 0);
  const permissionNotice = featureFlagPermissionNotice(canWrite, canEmergency);
  return <OpsPage eyebrow="FEATURE FLAGS" title="功能开关" description="按环境管理类型化开关、定向灰度和紧急关闭；全部变更保留 revision 与不可变审计。">
    {model.error && <Alert role="alert" type="error" showIcon title="功能开关操作失败" description={model.error} action={<Button style={{ minHeight: 44 }} onClick={() => void model.load()}>重试</Button>} />}
    {permissionNotice ? <Alert type="info" showIcon role="status" title="当前为受限操作状态" description={permissionNotice} /> : null}
    <Space wrap aria-label="功能开关筛选">
      <Input.Search allowClear aria-label="搜索开关键或说明" placeholder="搜索开关键或说明" style={{ width: 280 }} onSearch={query => model.setFilters({ ...model.filters, query })} />
      <Select aria-label="功能开关环境筛选" value={model.filters.environment} style={{ width: 200 }} onChange={environment => model.setFilters({ ...model.filters, environment })} options={featureFlagEnvironmentOptions(environmentConfig.environments)} />
      <Button style={{ minHeight: 44 }} icon={<ReloadOutlined aria-hidden />} onClick={() => void model.load()}>刷新</Button>
      {canWrite && <Button style={{ minHeight: 44 }} type="primary" disabled={initialLoadFailed} title={initialLoadFailed ? "请先修复工作区配置并刷新开关" : undefined} icon={<PlusOutlined aria-hidden />} onClick={() => setEditing("new")}>新建开关</Button>}
    </Space>
    {initialLoadFailed ? <Typography.Text type="secondary" role="status">功能开关数据尚未取得，请重试；当前状态不能解释为没有功能开关。</Typography.Text> : <FeatureFlagsTable items={model.items} loading={model.loading} canWrite={canWrite} canEmergency={canEmergency} onEdit={setEditing} onAudit={setAudit} onEmergency={flag => { setEmergencyTarget(flag); setEmergencyReason(""); }} />}
    {model.nextCursor && <Button style={{ minHeight: 44 }} loading={model.loadingMore} onClick={() => void model.load(model.nextCursor)}>加载更多</Button>}
    <FeatureFlagEditor open={Boolean(editing)} flag={editing === "new" ? undefined : editing} saving={model.saving} defaultEnvironment={model.filters.environment ?? environmentConfig.defaultEnvironment} environments={environmentConfig.environments} onCancel={() => setEditing(undefined)} onSave={model.save} />
    <FeatureFlagAuditDrawer flag={audit} loadEvents={model.loadEvents} onClose={() => setAudit(undefined)} />
    <Modal open={Boolean(emergencyTarget)} title={emergencyTarget?.emergencyDisabled ? "恢复功能开关？" : "紧急关闭功能开关？"} okText={emergencyTarget?.emergencyDisabled ? "确认恢复" : "紧急关闭"} okButtonProps={{ danger: !emergencyTarget?.emergencyDisabled, disabled: emergencyReason.trim().length < 3, loading: model.saving }} cancelText="取消" onCancel={() => setEmergencyTarget(undefined)} onOk={async () => { if (!emergencyTarget) return; await model.setEmergency({ id: emergencyTarget.id, disabled: !emergencyTarget.emergencyDisabled, expectedRevision: emergencyTarget.revision, idempotencyKey: crypto.randomUUID(), reason: emergencyReason.trim() }); setEmergencyTarget(undefined); }}>
      <Alert type={emergencyTarget?.emergencyDisabled ? "info" : "warning"} showIcon title={emergencyTarget?.emergencyDisabled ? "恢复后仍受总开关、有效期和定向规则约束。" : "紧急关闭优先于所有定向规则，并会写入不可变审计。"} />
      <label htmlFor="feature-flag-emergency-reason" style={{ display: "block", marginTop: 16, marginBottom: 8 }}>操作原因</label>
      <Input.TextArea id="feature-flag-emergency-reason" value={emergencyReason} onChange={event => setEmergencyReason(event.target.value)} rows={3} maxLength={500} showCount placeholder="至少 3 个字符，供审计和事故复盘" />
    </Modal>
  </OpsPage>;
}
