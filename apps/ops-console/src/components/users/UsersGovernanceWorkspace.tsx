import { useEffect, useMemo, useState } from "react";
import { Alert, Tabs, type TabsProps } from "antd";
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

export function UsersGovernanceWorkspace({ model }: { model: OpsConsoleModel }) {
  const sectionKeys = useMemo(() => visibleUsersGovernanceSections(model.authorization), [model.authorization]);
  const [activeSection, setActiveSection] = useState<UsersGovernanceSectionKey>(sectionKeys[0] ?? "directory");

  useEffect(() => {
    if (!sectionKeys.includes(activeSection) && sectionKeys[0]) setActiveSection(sectionKeys[0]);
  }, [activeSection, sectionKeys]);

  if (!sectionKeys.length) {
    return <Alert showIcon type="warning" title="当前角色没有用户治理视图" description="需要身份目录、租户目录或平台授权中心的读取能力。权限由服务端策略决定。" />;
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
