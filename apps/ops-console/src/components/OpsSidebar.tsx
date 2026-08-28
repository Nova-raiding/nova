import {
  CloudSyncOutlined,
  DollarOutlined,
  GlobalOutlined,
  RobotOutlined,
  TeamOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import { Layout } from "antd";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { OpsDomain } from "../navigation/opsNavigation";

interface StoreNavItem {
  platform: string;
  accountId: string;
  label: string;
  state: string;
}

interface OpsSidebarProps {
  activeDomain: OpsDomain;
  stores: StoreNavItem[];
  platformLabels: Record<string, string>;
  selectedStoreScope: string;
  onNavigate: (domain: OpsDomain) => void;
  onSelectStore: (scope: string) => void | Promise<unknown>;
}

export function selectStoreAndNavigate(
  scope: string,
  onSelectStore: OpsSidebarProps["onSelectStore"],
  navigate: (domain: OpsDomain) => void,
) {
  const selection = onSelectStore(scope);
  navigate("stores");
  return selection;
}

export const mainItems: Array<{ domain: OpsDomain; label: string; icon: ReactNode }> =
  [
    { domain: "overview", label: "总览", icon: <SafetyCertificateOutlined /> },
    { domain: "users", label: "用户与租户", icon: <TeamOutlined /> },
    { domain: "tasks", label: "任务与内容", icon: <CloudSyncOutlined /> },
    { domain: "stores", label: "商家与店铺", icon: <GlobalOutlined /> },
    { domain: "models", label: "模型服务", icon: <RobotOutlined /> },
    { domain: "finance", label: "账务与退款", icon: <DollarOutlined /> },
  ];

export function OpsSidebar({
  activeDomain,
  stores,
  platformLabels,
  selectedStoreScope,
  onNavigate,
  onSelectStore,
}: OpsSidebarProps) {
  const [mobileCollapsed, setMobileCollapsed] = useState(false);
  const mobileTriggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (mobileCollapsed && window.matchMedia("(max-width: 991px)").matches) window.requestAnimationFrame(() => mobileTriggerRef.current?.focus({ preventScroll: true }));
  }, [mobileCollapsed]);
  const navigate = (domain: OpsDomain) => { onNavigate(domain); if (window.matchMedia("(max-width: 991px)").matches) setMobileCollapsed(true); };
  const groupedStores = Object.entries(
    stores.reduce<Record<string, StoreNavItem[]>>((groups, store) => {
      (groups[store.platform] ??= []).push(store);
      return groups;
    }, {}),
  );

  return (<>
    <button ref={mobileTriggerRef} className="mobile-menu-trigger" type="button" aria-controls="ops-primary-navigation" aria-expanded={!mobileCollapsed} aria-label={mobileCollapsed ? "打开运营导航" : "关闭运营导航"} onClick={() => { if (mobileCollapsed) { setMobileCollapsed(false); window.setTimeout(() => document.querySelector<HTMLButtonElement>("#ops-primary-navigation button")?.focus({ preventScroll: true }), 250); } else setMobileCollapsed(true); }}>
      <span aria-hidden="true">☰</span>
    </button>
    <Layout.Sider id="ops-primary-navigation" breakpoint="lg" collapsible collapsed={mobileCollapsed} collapsedWidth="0" trigger={null} onBreakpoint={(broken) => setMobileCollapsed(broken)} onKeyDown={(event) => { if (event.key === "Escape") setMobileCollapsed(true); }} className="ops-sider">
      <div className="brand-mark">
        <span>大麦</span>
        <div>
          <strong>大麦运营中心</strong>
          <small>平台运营与商家服务</small>
        </div>
      </div>
      <div className="sider-caption">WORKSPACE</div>
      {mainItems.slice(0, 5).map((item) => (
        <button
          key={item.domain}
          className={`sider-item${activeDomain === item.domain ? " active" : ""}`}
          type="button"
          aria-label={item.label}
          aria-current={activeDomain === item.domain ? "page" : undefined}
          onClick={() => navigate(item.domain)}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
      <div className="sider-caption store-tree-caption">
        租户店铺 <span>{stores.length}</span>
      </div>
      <button
        className={`sider-subitem${activeDomain === "stores" && !selectedStoreScope ? " selected" : ""}`}
        type="button"
        onClick={() => {
          void selectStoreAndNavigate("", onSelectStore, navigate);
        }}
      >
        全部租户店铺
      </button>
      {groupedStores.map(([platform, rows]) => (
        <div className="store-tree-group" key={platform}>
          <div className="store-tree-platform">
            {platformLabels[platform] ?? platform}{" "}
            <span>{rows?.length ?? 0}</span>
          </div>
          {rows?.map((store) => {
            const scope = `${store.platform}:${store.accountId}`;
            return (
              <button
                className={`sider-subitem store-tree-store${selectedStoreScope === scope ? " selected" : ""}`}
                type="button"
                key={scope}
                title={`${store.label} · ${platformLabels[store.platform] ?? store.platform}`}
                onClick={() => {
                  void selectStoreAndNavigate(scope, onSelectStore, navigate);
                }}
              >
                <span
                  className={`store-status ${store.state === "connected" ? "online" : "warning"}`}
                />
                {store.label}
              </button>
            );
          })}
        </div>
      ))}
      <button
        className={`sider-item${activeDomain === "finance" ? " active" : ""}`}
        type="button"
        aria-label={mainItems[5].label}
        aria-current={activeDomain === "finance" ? "page" : undefined}
        onClick={() => navigate("finance")}
      >
        {mainItems[5].icon}
        {mainItems[5].label}
      </button>
    </Layout.Sider>
  </>);
}
