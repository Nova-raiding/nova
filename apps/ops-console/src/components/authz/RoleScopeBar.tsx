import { ClockCircleOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { Space, Tag, Typography } from "antd";
import { useEffect, useState } from "react";
import type { AuthorizationProjection } from "../../authz/authorization.js";
import type { OpsSession } from "../../types/ops.js";
import type { OpsWorkbench } from "../../types/ops.js";
import { OpsWorkbenchSwitcher } from "./OpsWorkbenchSwitcher.js";

const roleLabels: Record<string, string> = {
  platform_admin: "平台管理员", ops_admin: "平台运营", support_agent: "平台客服",
  finance_ops: "平台财务", security_admin: "安全管理员", auditor: "平台审计",
  rules_admin: "规则管理员", model_admin: "模型管理员", release_admin: "发布管理员",
  workspace_owner: "工作区所有者", workspace_admin: "商家管理员", operator: "商家运营",
  workspace_support: "工作区客服", reviewer: "内容审核", finance: "工作区财务", viewer: "只读成员",
};

const scopeLabel = (authorization: AuthorizationProjection) => {
  const { scope } = authorization;
  if (scope.kind === "platform") return "平台全局";
  if (scope.kind === "controlled_support") return `受控支持 · ${scope.id ?? "未识别工作区"}`;
  const prefix = { workspace: "工作区", brand: "品牌", store: "店铺" }[scope.kind];
  return `${prefix} · ${scope.id ?? "未识别"}`;
};

export function formatJitRemaining(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(totalSeconds / 60).toString().padStart(2, "0")}:${(totalSeconds % 60).toString().padStart(2, "0")}`;
}

export function RoleScopeBar({
  session,
  authorization,
  activeWorkbench,
  availableWorkbenches: projectedWorkbenches,
  switching,
  onWorkbenchChange,
  onJitExpired,
}: {
  session?: OpsSession;
  authorization: AuthorizationProjection;
  activeWorkbench?: OpsWorkbench;
  availableWorkbenches?: readonly OpsWorkbench[];
  switching?: boolean;
  onWorkbenchChange?: (workbench: OpsWorkbench) => void;
  onJitExpired?: () => void;
}) {
  const roles = authorization.roles;
  const primaryRole = roles[0] ? roleLabels[roles[0]] ?? roles[0] : "权限未验证";
  const activeGrant = session?.temporary_grants?.find(
    (grant) => !grant.expires_at || Date.parse(grant.expires_at) > Date.now(),
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const expiresAt = activeGrant?.expires_at ? Date.parse(activeGrant.expires_at) : NaN;
    if (!Number.isFinite(expiresAt)) return undefined;
    let expiredNotified = false;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      if (current >= expiresAt && !expiredNotified) {
        expiredNotified = true;
        onJitExpired?.();
      }
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [activeGrant?.id, activeGrant?.expires_at, onJitExpired]);
  const workbench = activeWorkbench ?? session?.workbench ?? (authorization.scope.kind === "platform" ? "platform" : "workspace");
  // Candidate workbenches come only from the server projection. Raw roles are
  // never used to manufacture a switch target.
  const availableWorkbenches = session?.available_workbenches ?? projectedWorkbenches ?? [workbench];
  return (
    <section className="role-scope-bar" aria-label="当前身份与权限范围">
      <Space size={8} wrap>
        <SafetyCertificateOutlined aria-hidden="true" />
        <Typography.Text strong>{primaryRole}</Typography.Text>
        <Typography.Text type="secondary">身份 {session?.actor_id ?? "未验证"}</Typography.Text>
        {roles.length > 1 ? <Tag>+{roles.length - 1} 个角色</Tag> : null}
        <OpsWorkbenchSwitcher value={workbench} available={availableWorkbenches} switching={switching} onChange={onWorkbenchChange} />
        <Typography.Text>{scopeLabel(authorization)}</Typography.Text>
        <Typography.Text type="secondary">策略 {authorization.policyVersion ?? "未返回"}</Typography.Text>
        {activeGrant ? (
          <span className="ops-jit-status" aria-live="polite">
            <Tag color="gold" icon={<ClockCircleOutlined aria-hidden="true" />}>
              临时授权 · {activeGrant.access_mode === "write" ? "可写" : "只读"} · 剩余 {activeGrant.expires_at ? formatJitRemaining(Date.parse(activeGrant.expires_at) - now) : "会话结束"}
            </Tag>
            <Typography.Text type="secondary">
              范围 {activeGrant.resource_scope?.type ?? "workspace"}:{activeGrant.resource_scope?.ids?.join(", ") ?? activeGrant.workspace_id ?? "未返回"}
              {activeGrant.max_uses !== undefined ? ` · 使用 ${activeGrant.use_count ?? 0}/${activeGrant.max_uses}` : ""}
            </Typography.Text>
          </span>
        ) : null}
      </Space>
    </section>
  );
}
