import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Tabs, type TabsProps } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import { OpsPageError } from "../OpsPageError";
import { AuthorizationGovernanceSection } from "./AuthorizationGovernanceSection";
import { UserDirectorySection } from "./UserDirectorySection";
import { WorkspaceGovernanceSection } from "./WorkspaceGovernanceSection";

export type UsersGovernanceSectionKey = "directory" | "workspaces" | "authorization";

type CapabilityReader = Pick<OpsConsoleModel["authorization"], "can">;

export function visibleUsersGovernanceSections(authorization: CapabilityReader): UsersGovernanceSectionKey[] {
  const sections: UsersGovernanceSectionKey[] = [];
  if (authorization.can("identity.read")) sections.push("directory");
  if (authorization.can("workspace.directory.read")) sections.push("workspaces");
  if (authorization.can("authorization.role.read") || authorization.can("authorization.grant.read")) sections.push("authorization");
  return sections;
}

export function UsersGovernanceWorkspace({ model, onRefresh }: { model: OpsConsoleModel; onRefresh?: () => void }) {
  const sectionKeys = useMemo(() => visibleUsersGovernanceSections(model.authorization), [model.authorization]);
  const [activeSection, setActiveSection] = useState<UsersGovernanceSectionKey>(sectionKeys[0] ?? "directory");
  const unavailableRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sectionKeys.includes(activeSection) && sectionKeys[0]) setActiveSection(sectionKeys[0]);
  }, [activeSection, sectionKeys]);

  useEffect(() => {
    if (!sectionKeys.length) unavailableRef.current?.focus({ preventScroll: true });
  }, [sectionKeys.length]);

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
        description="需要身份目录、租户目录或平台授权中心的读取能力。权限由服务端策略决定，不会把未授权结果显示为空数据。"
        action={onRefresh ? <Button size="small" style={{ minHeight: 44 }} aria-label="刷新用户治理权限" onClick={onRefresh}>刷新权限</Button> : undefined}
      />
    </div>;
  }

  const items: TabsProps["items"] = sectionKeys.map((key) => {
    if (key === "directory") {
      return {
        key,
        label: "用户目录",
        children: <>
          <OpsPageError error={model.userDirectoryError} onRetry={() => void model.loadUsers()} />
          <UserDirectorySection model={model} />
        </>,
      };
    }
    if (key === "workspaces") return { key, label: "租户治理", children: <WorkspaceGovernanceSection model={model} /> };
    return { key, label: "权限与角色", children: <AuthorizationGovernanceSection model={model} /> };
  });

  return (
    <div className="ops-users-workspace">
      <Tabs
        activeKey={activeSection}
        onChange={(key) => setActiveSection(key as UsersGovernanceSectionKey)}
        items={items}
        destroyOnHidden
        aria-label="用户治理工作区"
      />
    </div>
  );
}
