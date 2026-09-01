import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, App as AntApp, Button, Layout, Modal, Result, Skeleton } from "antd";
import { OpsHeader } from "../components/OpsHeader";
import { mainItems, OpsSidebar } from "../components/OpsSidebar";
import { useOpsConsoleModel, type OpsConsoleModel } from "../hooks/useOpsConsoleModel";
import { useOpsNavigation } from "../navigation/useOpsNavigation";
import { opsPageRegistry } from "../navigation/opsPageRegistry.js";
import { platformLabels } from "../types/ops";
import { abortOpsRequests, managedOpsSession, readOpsConnectionConfig, setOpsWorkbenchContext } from "../api/opsClient";
import { OpsPageBoundary } from "../components/OpsPageBoundary";
import { canViewOpsDomain, domainFromLocation, requiredWorkbenchForDomain, urlForDomain, visibleOpsDomains } from "../navigation/opsNavigation.js";
import { AuthorizationProvider } from "../authz/AuthorizationProvider.js";
import { AccessDeniedResult } from "../components/authz/AccessDeniedResult.js";
import { domainReadCapabilities } from "../authz/authorization.js";
import type { OpsWorkbench } from "../types/ops.js";
import { urlForWorkbench, workbenchIntentFromLocation } from "../navigation/opsWorkbenchLocation.js";
import { UnsavedChangesProvider, useUnsavedChangesState } from "../components/authz/UnsavedChangesContext.js";
import { normalizeDiagnosticTokens } from "../components/opsErrorPresentation.js";

const { Content } = Layout;

export function commitOpsWorkbenchTransition(
  next: OpsWorkbench,
  pushHistory: boolean,
  dependencies: {
    abort: () => unknown;
    persist: (workbench: OpsWorkbench) => unknown;
    location: Pick<Location, "pathname" | "search" | "hash">;
    push: (url: string) => void;
    replace: (url: string) => void;
  } = {
    abort: () => abortOpsRequests(),
    persist: setOpsWorkbenchContext,
    location: window.location,
    push: (url) => window.history.pushState(null, "", url),
    replace: (url) => window.history.replaceState(null, "", url),
  },
  prepare?: () => unknown,
) {
  dependencies.abort();
  prepare?.();
  dependencies.persist(next);
  const target = urlForWorkbench(dependencies.location, next);
  (pushHistory ? dependencies.push : dependencies.replace)(target);
  return target;
}

export function shouldConfirmWorkbenchTransition(
  current: OpsWorkbench,
  next: OpsWorkbench,
  unsavedLabels: readonly string[],
) {
  return next !== current && unsavedLabels.length > 0;
}

export function opsSessionGateState(
  managed: boolean,
  sessionLoaded: boolean,
  sessionError?: string,
): "ready" | "loading" | "blocked" {
  if (sessionLoaded) return "ready";
  if (sessionError) return "blocked";
  if (!managed) return "ready";
  return "loading";
}

export function opsContentLoadingMessage(
  sessionGate: ReturnType<typeof opsSessionGateState>,
  switchingWorkbench: boolean,
  loading: boolean,
) {
  if (switchingWorkbench) return "正在切换运营工作台，旧工作台数据已清除";
  if (sessionGate === "loading") return "正在验证运营权限";
  if (loading) return "正在刷新运营数据";
  return "";
}

export function accessDeniedReasonCode(
  evidence: { code?: string; details?: Readonly<Record<string, unknown>> } | undefined,
): string | undefined {
  const reasonCode = evidence?.details?.reason_code;
  return typeof reasonCode === "string" && reasonCode.trim() ? reasonCode.trim() : evidence?.code;
}

export function accessDeniedEvidence(
  evidence: { details?: Readonly<Record<string, unknown>> } | undefined,
): { decisionId?: string; obligationsMissing?: string[] } {
  const details = evidence?.details;
  const decisionId = typeof details?.decision_id === "string" && details.decision_id.trim()
    ? details.decision_id.trim()
    : undefined;
  const obligationsMissing = normalizeDiagnosticTokens(details?.obligations_missing);
  return {
    ...(decisionId ? { decisionId } : {}),
    ...(obligationsMissing?.length ? { obligationsMissing } : {}),
  };
}

export async function selectStoreScope(
  model: Pick<OpsConsoleModel, "setSelectedStoreScope" | "loadAutomationScope">,
  scope: string,
) {
  model.setSelectedStoreScope(scope);
  return model.loadAutomationScope(scope);
}

function Dashboard({
  model,
  activeWorkbench,
  switchingWorkbench,
  onWorkbenchChange,
  availableWorkbenches,
  onAvailableWorkbenches,
}: {
  model: OpsConsoleModel;
  activeWorkbench: OpsWorkbench;
  switchingWorkbench: boolean;
  onWorkbenchChange: (workbench: OpsWorkbench, pushHistory?: boolean, prepare?: () => unknown, cancel?: () => unknown) => void;
  availableWorkbenches: readonly OpsWorkbench[];
  onAvailableWorkbenches: (workbenches: readonly OpsWorkbench[]) => void;
}) {
  const deferredPopstate = (domain: Parameters<typeof requiredWorkbenchForDomain>[0], commit: () => void) => {
    const targetWorkbench = workbenchIntentFromLocation(window.location) ?? requiredWorkbenchForDomain(domain);
    if (!targetWorkbench || targetWorkbench === activeWorkbench) return false;
    const targetUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const currentDomainUrl = urlForDomain(window.location, activeDomain);
    const currentLocation = new URL(currentDomainUrl, window.location.origin);
    const currentUrl = urlForWorkbench(currentLocation, activeWorkbench);
    window.history.replaceState(null, "", currentUrl);
    onWorkbenchChange(targetWorkbench, false, () => {
      window.history.replaceState(null, "", targetUrl);
      commit();
    }, () => window.history.replaceState(null, "", currentUrl));
    return true;
  };
  const { activeDomain, navigate: navigateToRoute } = useOpsNavigation({ onPopstate: deferredPopstate });
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const sessionError = !model.opsSession
    ? model.dataSetError("ops.session")
    : undefined;
  const sessionErrorEvidence = model.dataSetErrorEvidence("ops.session");
  const sessionAccessDeniedEvidence = accessDeniedEvidence(sessionErrorEvidence);
  const sessionGate = opsSessionGateState(managedOpsSession, Boolean(model.opsSession), sessionError);
  const sessionErrorRef = useRef<HTMLDivElement>(null);
  const loadingMessage = opsContentLoadingMessage(sessionGate, switchingWorkbench, model.loading);
  const sessionReady = sessionGate === "ready";
  const visibleDomains = visibleOpsDomains(model.authorization);
  const authorized = sessionReady && canViewOpsDomain(activeDomain, model.authorization);
  const ActivePage = opsPageRegistry[activeDomain];
  const navigateToDomain = (domain: Parameters<typeof navigateToRoute>[0]) => {
    const requiredWorkbench = requiredWorkbenchForDomain(domain);
    if (requiredWorkbench && requiredWorkbench !== activeWorkbench) {
      onWorkbenchChange(requiredWorkbench, false, () => navigateToRoute(domain));
      return;
    }
    navigateToRoute(domain);
  };

  useEffect(() => {
    if (model.opsSession?.available_workbenches?.length) {
      onAvailableWorkbenches(model.opsSession.available_workbenches);
    }
  }, [model.opsSession?.available_workbenches?.join("|")]);

  useEffect(() => {
    // Keep domain-specific hydration behind the same client-side visibility
    // gate as navigation. The API remains authoritative, but an operator
    // should not generate predictable 403 noise for domains they cannot use
    // every time the overview or refresh action runs.
    const canRead = (domain: Parameters<typeof canViewOpsDomain>[0]) =>
      canViewOpsDomain(domain, model.authorization);
    if (activeDomain === "rules" && activeWorkbench === "workspace" && canRead("rules"))
      void model.loadRules();
    if (activeDomain === "finance" && activeWorkbench === "platform" && canRead("finance"))
      void model.loadRechargeOrders();
    if ((activeDomain === "overview" || activeDomain === "models") && model.canModelMarkup && readOpsConnectionConfig().workbench === "platform") void model.loadModelMarkup();
    if (activeDomain === "users" && canRead("users")) void model.loadUsers();
  }, [activeDomain, model.canUserGovernance, model.opsSession?.actor_id]);

  useEffect(() => {
    if (sessionGate !== "blocked") return;
    const focusTimer = window.requestAnimationFrame(() => sessionErrorRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(focusTimer);
  }, [sessionGate]);

  return (
    <Layout className="ops-shell">
      <a className="ops-skip-link" href="#ops-main-content">
        跳转到主要内容
      </a>
      <OpsSidebar
        activeDomain={activeDomain}
        stores={model.storeDirectory}
        platformLabels={platformLabels}
        selectedStoreScope={model.selectedStoreScope}
        workspaceId={model.opsSession?.workspace_id}
        scope={model.authorization.scope}
        onNavigate={navigateToDomain}
        onSelectStore={(scope) => selectStoreScope(model, scope)}
        visibleDomains={visibleDomains}
        onMobileOpenChange={setMobileNavigationOpen}
      />
      <Layout inert={mobileNavigationOpen || undefined} aria-hidden={mobileNavigationOpen || undefined}>
        <OpsHeader
          managedSession={managedOpsSession}
          roles={model.opsSession?.roles}
          sessionLoaded={Boolean(model.opsSession)}
          dataSource={model.dataSource}
          refreshing={model.loading}
          session={model.opsSession}
          authorization={model.authorization}
          activeWorkbench={activeWorkbench}
          availableWorkbenches={availableWorkbenches}
          switchingWorkbench={switchingWorkbench}
          onWorkbenchChange={onWorkbenchChange}
          onJitExpired={() => { model.clearAuthorizationScopedData(); void model.load(); }}
          onJitExit={() => { model.clearAuthorizationScopedData(); void model.load(); }}
          onRefresh={() => {
            void model.load();
            if (model.canModelMarkup && canViewOpsDomain("models", model.authorization) && readOpsConnectionConfig().workbench === "platform")
              void model.loadModelMarkup();
            if (canViewOpsDomain("rules", model.authorization))
              void model.loadRules();
            if (canViewOpsDomain("finance", model.authorization))
              void model.loadRechargeOrders();
            if (model.canUserGovernance && canViewOpsDomain("users", model.authorization))
              void model.loadUsers();
          }}
        />
        <Content id="ops-main-content" className="ops-content" role="main" tabIndex={-1} aria-busy={Boolean(loadingMessage)}>
          <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {loadingMessage}
          </span>
          {model.error && sessionGate !== "blocked" ? (
            <Alert
              className="ops-global-load-warning"
              role="status"
              type="warning"
              showIcon
              title="部分运营数据未刷新"
              description={model.error}
            />
          ) : null}
          {sessionGate === "blocked" ? (
            <div ref={sessionErrorRef} className="ops-session-error" role="alert" aria-live="assertive" aria-atomic="true" tabIndex={-1} aria-labelledby="ops-session-error-title">
              <Result
                status="error"
                title={<span id="ops-session-error-title">无法验证运营权限</span>}
                subTitle={`${sessionError ?? "权限会话加载失败"}。为保护运营数据，当前会话已拒绝所有页面与动作。`}
                extra={<Button type="primary" aria-label="重试权限验证" style={{ minHeight: 44 }} onClick={() => void model.load()}>重试权限验证</Button>}
              />
            </div>
          ) : sessionGate === "loading" ? (
            <Skeleton active paragraph={{ rows: 8 }} aria-label="正在验证运营权限" />
          ) : authorized ? (
            <OpsPageBoundary resetKey={activeDomain}>
              <Suspense fallback={<Skeleton active paragraph={{ rows: 8 }} aria-label="正在加载页面" />}>
                <ActivePage model={model} onNavigate={navigateToDomain} />
              </Suspense>
            </OpsPageBoundary>
          ) : (
            <AccessDeniedResult
              domainLabel={mainItems.find((item) => item.domain === activeDomain)?.label ?? activeDomain}
              capability={domainReadCapabilities[activeDomain][0]}
              scope={model.authorization.scope}
              requestId={sessionErrorEvidence?.requestId}
              traceId={sessionErrorEvidence?.traceId}
              reasonCode={accessDeniedReasonCode(sessionErrorEvidence)}
              decisionId={sessionAccessDeniedEvidence.decisionId}
              obligationsMissing={sessionAccessDeniedEvidence.obligationsMissing}
              onBack={() => navigateToDomain("overview")}
              onRefresh={() => void model.load()}
              refreshing={model.loading}
            />
          )}
        </Content>
      </Layout>
    </Layout>
  );
}

export function OpsConsoleController() {
  return <UnsavedChangesProvider><OpsConsoleControllerContent /></UnsavedChangesProvider>;
}

function OpsConsoleControllerContent() {
  const [activeWorkbench, setActiveWorkbench] = useState<OpsWorkbench>(() =>
    workbenchIntentFromLocation(window.location)
      ?? requiredWorkbenchForDomain(domainFromLocation(window.location))
      ?? readOpsConnectionConfig().workbench,
  );
  const [contextReady, setContextReady] = useState(false);
  const [switchingWorkbench, setSwitchingWorkbench] = useState(false);
  const [availableWorkbenches, setAvailableWorkbenches] = useState<readonly OpsWorkbench[]>([activeWorkbench]);
  const [pendingWorkbench, setPendingWorkbench] = useState<{ next: OpsWorkbench; pushHistory: boolean; prepare?: () => unknown; cancel?: () => unknown }>();
  const { clearAll: clearUnsavedChanges, labels: unsavedLabels } = useUnsavedChangesState();

  const commitWorkbench = (next: OpsWorkbench, pushHistory: boolean, prepare?: () => unknown) => {
    if (next === activeWorkbench && contextReady) return;
    clearUnsavedChanges();
    setSwitchingWorkbench(true);
    commitOpsWorkbenchTransition(next, pushHistory, undefined, prepare);
    setActiveWorkbench(next);
    setContextReady(true);
    window.requestAnimationFrame(() => setSwitchingWorkbench(false));
  };
  const activateWorkbench = (next: OpsWorkbench, pushHistory: boolean, prepare?: () => unknown, cancel?: () => unknown) => {
    if (shouldConfirmWorkbenchTransition(activeWorkbench, next, unsavedLabels)) {
      setPendingWorkbench({ next, pushHistory, prepare, cancel });
      return;
    }
    commitWorkbench(next, pushHistory, prepare);
  };

  useEffect(() => {
    setOpsWorkbenchContext(activeWorkbench);
    setContextReady(true);
  }, []);
  return (
    <OpsAntAppBoundary>
      {contextReady ? (
        <OpsConsoleRuntime
          key={activeWorkbench}
          activeWorkbench={activeWorkbench}
          switchingWorkbench={switchingWorkbench}
          availableWorkbenches={availableWorkbenches}
          onAvailableWorkbenches={setAvailableWorkbenches}
          onWorkbenchChange={(next, pushHistory = true, prepare, cancel) => activateWorkbench(next, pushHistory, prepare, cancel)}
        />
      ) : <Skeleton active paragraph={{ rows: 8 }} aria-label="正在初始化运营工作台" />}
      <Modal
        open={Boolean(pendingWorkbench)}
        title="放弃未保存内容并切换工作台？"
        okText="放弃并切换"
        cancelText="继续编辑"
        okButtonProps={{ danger: true }}
        onCancel={() => {
          pendingWorkbench?.cancel?.();
          setPendingWorkbench(undefined);
        }}
        onOk={() => {
          if (!pendingWorkbench) return;
          const target = pendingWorkbench;
          setPendingWorkbench(undefined);
          commitWorkbench(target.next, target.pushHistory, target.prepare);
        }}
      >
        当前未保存：{unsavedLabels.join("、")}。切换后这些内容会被清除且无法恢复。
      </Modal>
    </OpsAntAppBoundary>
  );
}

export function OpsAntAppBoundary({ children }: { children: ReactNode }) {
  return <AntApp>{children}</AntApp>;
}

function OpsConsoleRuntime({
  activeWorkbench,
  switchingWorkbench,
  onWorkbenchChange,
  availableWorkbenches,
  onAvailableWorkbenches,
}: {
  activeWorkbench: OpsWorkbench;
  switchingWorkbench: boolean;
  onWorkbenchChange: (workbench: OpsWorkbench, pushHistory?: boolean, prepare?: () => unknown, cancel?: () => unknown) => void;
  availableWorkbenches: readonly OpsWorkbench[];
  onAvailableWorkbenches: (workbenches: readonly OpsWorkbench[]) => void;
}) {
  const model = useOpsConsoleModel();
  const switchWorkbench = (next: OpsWorkbench, pushHistory = true, prepare?: () => unknown, cancel?: () => unknown) => {
    // Delay cleanup until the controller accepts the switch. If the dirty
    // guard opens and the operator chooses “继续编辑”, clearing here would
    // destroy the draft before the confirmation decision is made.
    onWorkbenchChange(next, pushHistory, () => {
      model.clearAuthorizationScopedData();
      prepare?.();
    }, cancel);
  };
  return (
    <AuthorizationProvider authorization={model.authorization}>
      <Dashboard model={model} activeWorkbench={activeWorkbench} switchingWorkbench={switchingWorkbench} onWorkbenchChange={switchWorkbench} availableWorkbenches={availableWorkbenches} onAvailableWorkbenches={onAvailableWorkbenches} />
    </AuthorizationProvider>
  );
}
