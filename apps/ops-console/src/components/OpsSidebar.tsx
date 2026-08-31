import {
  CloudSyncOutlined,
  DollarOutlined,
  GlobalOutlined,
  RobotOutlined,
  TeamOutlined,
  UsergroupAddOutlined,
  SafetyCertificateOutlined,
  FileSearchOutlined,
  ReadOutlined,
  AlertOutlined,
  CustomerServiceOutlined,
  ExperimentOutlined,
  MenuOutlined,
  CloudServerOutlined,
} from "@ant-design/icons";
import { Layout } from "antd";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { OpsDomain } from "../navigation/opsNavigation";
import type { OpsScope } from "../authz/authorization.js";

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
  workspaceId?: string;
  scope?: OpsScope;
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

export const mainItems: Array<{ domain: OpsDomain; label: string; icon: ReactNode }> =
  [
    { domain: "overview", label: "总览", icon: <SafetyCertificateOutlined /> },
    { domain: "users", label: "用户与租户", icon: <TeamOutlined /> },
    { domain: "members", label: "成员与权限", icon: <UsergroupAddOutlined /> },
    { domain: "support", label: "客服与 CRM", icon: <CustomerServiceOutlined /> },
    { domain: "incidents", label: "事故中心", icon: <AlertOutlined /> },
    { domain: "tasks", label: "任务与内容", icon: <CloudSyncOutlined /> },
    { domain: "stores", label: "平台连接", icon: <GlobalOutlined /> },
    { domain: "rules", label: "平台规则", icon: <ReadOutlined /> },
    { domain: "models", label: "模型服务", icon: <RobotOutlined /> },
    { domain: "feature-flags", label: "功能开关", icon: <ExperimentOutlined /> },
    { domain: "storage", label: "存储与对账", icon: <CloudServerOutlined /> },
    { domain: "finance", label: "账务与退款", icon: <DollarOutlined /> },
    { domain: "audit", label: "审计中心", icon: <FileSearchOutlined /> },
  ];

export const navigationGroups: Array<{ key: string; label: string; items: readonly OpsDomain[] }> = [
  { key: "governance", label: "平台治理", items: ["overview", "users", "members", "support", "incidents"] },
  { key: "merchant-operations", label: "商家运营", items: ["tasks", "stores", "rules"] },
  { key: "model-billing", label: "模型与计费", items: ["models", "finance"] },
  { key: "risk-system", label: "风险与系统", items: ["feature-flags", "storage", "audit"] },
];

export function OpsSidebar({
  activeDomain,
  stores,
  platformLabels,
  selectedStoreScope,
  workspaceId,
  scope,
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
  const selectedPlatform = selectedStoreScope.split(":", 1)[0];
  const selectedPlatformLabel = selectedPlatform ? platformLabels[selectedPlatform] ?? "已选平台" : "未选择";
  const mobileOpen = !mobileCollapsed;
  const currentScope: OpsScope = scope ?? { kind: "platform" };
  const scopeId = currentScope.id ?? currentScope.ids?.[0] ?? workspaceId;
  const scopePresentation = {
    platform: {
      badge: "平台级",
      status: "正在查看平台聚合与控制面数据",
      label: "平台范围",
      value: "全平台",
      note: "客户内容默认不可见；进入工作区需受控授权",
    },
    workspace: {
      badge: "工作区",
      status: `正在操作工作区 ${scopeId || "未识别"}`,
      label: "工作区范围",
      value: scopeId || "未识别",
      note: "数据与操作仅限当前工作区",
    },
    brand: {
      badge: "品牌范围",
      status: `正在操作品牌 ${scopeId || "未识别"}`,
      label: "品牌范围",
      value: scopeId || "未识别",
      note: "数据与操作仅限已授权品牌",
    },
    store: {
      badge: "店铺范围",
      status: `正在操作店铺 ${scopeId || "未识别"}`,
      label: "店铺范围",
      value: scopeId || "未识别",
      note: "数据与操作仅限已授权店铺",
    },
    controlled_support: {
      badge: "临时授权",
      status: `正在受控支持工作区 ${scopeId || "未识别"}`,
      label: "授权范围",
      value: scopeId || "未识别",
      note: "临时访问受范围和时效限制；全部操作写入审计",
    },
  }[currentScope.kind];
  const showControlledSupport = visibleItems.some((item) => item.domain === "support")
    && (currentScope.kind === "platform" || currentScope.kind === "controlled_support");
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
          <small>平台运营与商家服务</small>
        </div>
      </div>
      <div className="sider-caption">平台运营控制面</div>
      <div className="ops-scope-panel" aria-label="当前平台与租户范围">
        <div className="ops-scope-heading">
          <div className="ops-scope-title">当前操作范围</div>
          <span className="ops-scope-badge">{scopePresentation.badge}</span>
        </div>
        <div className="ops-scope-status" role="status" aria-live="polite">
          {scopePresentation.status}
        </div>
        <div className="ops-scope-row"><span>{scopePresentation.label}</span><strong title={scopePresentation.value}>{scopePresentation.value}</strong></div>
        {currentScope.kind === "platform" ? <div className="ops-scope-row"><span>工作区上下文</span><strong title={workspaceId || "未进入工作区"}>{workspaceId || "未进入工作区"}</strong></div> : null}
        <div className="ops-scope-note">{scopePresentation.note}</div>
        {selectedStoreScope ? <div className="ops-scope-selection">连接范围 · {selectedPlatformLabel}（只读）</div> : null}
      </div>
      <nav className="ops-nav-groups" aria-label="平台运营功能导航">
        {navigationGroups.map((group) => {
          const groupItems = group.items.map((domain) => itemsByDomain.get(domain)).filter(Boolean) as typeof visibleItems;
          if (!groupItems.length) return null;
          return <section className="ops-nav-group" key={group.key} aria-labelledby={`ops-nav-group-${group.key}`}>
            <h2 id={`ops-nav-group-${group.key}`} className="ops-nav-group-title">{group.label}</h2>
            {groupItems.map((item) => <button key={item.domain} className={`sider-item${activeDomain === item.domain ? " active" : ""}`} type="button" aria-label={item.label} aria-current={activeDomain === item.domain ? "page" : undefined} onClick={() => navigate(item.domain)}>{item.icon}{item.label}</button>)}
          </section>;
        })}
      </nav>
      {showControlledSupport ? <button
        className="sider-subitem controlled-support-entry"
        type="button"
        aria-label="通过客服与 CRM 受控支持客户问题"
        onClick={() => navigate("support")}
      >
        受控支持入口
      </button> : null}
    </Layout.Sider>
  </>);
}
