import {
  DashboardOutlined,
  DollarOutlined,
  RobotOutlined,
  TeamOutlined,
  MenuOutlined,
  DatabaseOutlined,
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
  visibleDomains?: readonly OpsDomain[];
  onMobileOpenChange?: (open: boolean) => void;
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

export const mainItems: Array<{ domain: OpsDomain; label: string; description: string; icon: ReactNode }> =
  [
    { domain: "overview", label: "总览", description: "查看平台健康与待处理事项", icon: <DashboardOutlined /> },
    { domain: "users", label: "用户中心", description: "管理企业账号与授权范围", icon: <TeamOutlined /> },
    { domain: "knowledge", label: "知识库", description: "审核商家商品资料与规则", icon: <DatabaseOutlined /> },
    { domain: "models", label: "模型服务", description: "检查中转、用量与成本证据", icon: <RobotOutlined /> },
    { domain: "finance", label: "账务与退款", description: "核对收款、创意点与退款", icon: <DollarOutlined /> },
  ];

export const navigationGroups: Array<{ key: string; label: string; items: readonly OpsDomain[] }> = [
  { key: "governance", label: "平台治理", items: ["overview", "users"] },
  { key: "merchant-data", label: "商家数据", items: ["knowledge"] },
  { key: "model-billing", label: "模型与计费", items: ["models", "finance"] },
];

export function OpsSidebar({
  activeDomain,
  stores,
  platformLabels,
  selectedStoreScope,
  onNavigate,
  onSelectStore,
  visibleDomains,
  onMobileOpenChange,
}: OpsSidebarProps) {
  const [mobileCollapsed, setMobileCollapsed] = useState(false);
  const mobileTriggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (mobileCollapsed && window.matchMedia("(max-width: 991px)").matches) window.requestAnimationFrame(() => mobileTriggerRef.current?.focus({ preventScroll: true }));
  }, [mobileCollapsed]);
  useEffect(() => {
    onMobileOpenChange?.(!mobileCollapsed && window.matchMedia("(max-width: 991px)").matches);
  }, [mobileCollapsed, onMobileOpenChange]);
  const navigate = (domain: OpsDomain) => { onNavigate(domain); if (window.matchMedia("(max-width: 991px)").matches) setMobileCollapsed(true); };
  const visibleItems = visibleDomains
    ? mainItems.filter((item) => visibleDomains.includes(item.domain))
    : mainItems;
  const itemsByDomain = new Map(visibleItems.map((item) => [item.domain, item]));
  const mobileOpen = !mobileCollapsed;
  return (<>
    <button ref={mobileTriggerRef} className="mobile-menu-trigger" type="button" aria-controls="ops-primary-navigation" aria-expanded={!mobileCollapsed} aria-label={mobileCollapsed ? "打开运营导航" : "关闭运营导航"} onClick={() => { if (mobileCollapsed) { setMobileCollapsed(false); window.setTimeout(() => document.querySelector<HTMLButtonElement>("#ops-primary-navigation button")?.focus({ preventScroll: true }), 250); } else setMobileCollapsed(true); }}>
      <MenuOutlined aria-hidden="true" />
    </button>
    <button className={`ops-nav-backdrop${mobileOpen ? " open" : ""}`} type="button" aria-label="关闭运营导航" tabIndex={mobileOpen ? 0 : -1} onClick={() => setMobileCollapsed(true)} />
    <Layout.Sider id="ops-primary-navigation" aria-label="运营主导航" breakpoint="lg" collapsible collapsed={mobileCollapsed} collapsedWidth="0" trigger={null} onBreakpoint={(broken) => setMobileCollapsed(broken)} onKeyDown={(event) => {
      if (event.key === "Escape" && window.matchMedia("(max-width: 991px)").matches) { setMobileCollapsed(true); return; }
      if (event.key !== "Tab" || mobileCollapsed || !window.matchMedia("(max-width: 991px)").matches) return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled])")];
      const first = controls.at(0); const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }} className="ops-sider">
      <div className="brand-mark">
        <span>大麦</span>
        <div>
          <strong>大麦运营中心</strong>
          <small>平台运营后台</small>
        </div>
      </div>
      <div className="sider-caption">平台运营控制面</div>
      <nav className="ops-nav-groups" aria-label="平台运营功能导航">
        {navigationGroups.map((group) => {
          const groupItems = group.items.map((domain) => itemsByDomain.get(domain)).filter(Boolean) as typeof visibleItems;
          if (!groupItems.length) return null;
          return <section className="ops-nav-group" key={group.key} aria-labelledby={`ops-nav-group-${group.key}`}>
            <h2 id={`ops-nav-group-${group.key}`} className="ops-nav-group-title">{group.label}</h2>
            {groupItems.map((item) => <button key={item.domain} className={`sider-item${activeDomain === item.domain ? " active" : ""}`} type="button" aria-label={item.label} title={`${item.label}：${item.description}`} aria-description={item.description} aria-current={activeDomain === item.domain ? "page" : undefined} onClick={() => navigate(item.domain)}>{item.icon}<span className="sider-item-copy">{item.label}</span></button>)}
          </section>;
        })}
      </nav>
    </Layout.Sider>
  </>);
}
