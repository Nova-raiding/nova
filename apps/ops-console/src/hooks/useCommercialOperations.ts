import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AuthorizationProjection } from "../authz/authorization.js";
import { describeOpsError } from "../api/opsClient.js";
import {
  commercialCapabilities,
  commercialOperationsClient,
  type CommercialAccessBlock,
  type CommercialAccessSummary,
  type CommercialCatalogItem,
  type CommercialEntitlement,
  type CommercialOperationsClient,
  type CommercialOrderItem,
  type CommercialPage,
  type CreativePointLedgerEntry,
  type CreativePointRateItem,
  type ServiceFulfillmentItem,
} from "../api/commercialOperationsClient.js";
import type { OpsRequestError } from "../types/ops.js";

export const commercialViews = ["blocks", "entitlements", "ledger", "catalog", "orders", "rates", "services"] as const;
export type CommercialView = typeof commercialViews[number];

export const commercialViewLabels: Readonly<Record<CommercialView, string>> = {
  blocks: "阻断与恢复",
  entitlements: "Workspace 权益",
  ledger: "创意点账本",
  catalog: "商业目录",
  orders: "订单与支付",
  rates: "创意点费率",
  services: "服务履约",
};

export const commercialViewCapability: Readonly<Record<CommercialView, string>> = {
  blocks: commercialCapabilities.accessRead,
  entitlements: commercialCapabilities.entitlementRead,
  ledger: commercialCapabilities.pointRead,
  catalog: commercialCapabilities.catalogRead,
  orders: commercialCapabilities.orderRead,
  rates: commercialCapabilities.rateRead,
  services: commercialCapabilities.serviceRead,
};

export interface CommercialLoadError {
  message: string;
  code: string;
  requestId?: string;
  traceId?: string;
  httpStatus?: number;
  details?: Readonly<Record<string, unknown>>;
  nextActions?: readonly unknown[];
}

export interface CommercialDataState<T> {
  status: "idle" | "loading" | "ready" | "error" | "forbidden";
  data?: T;
  error?: CommercialLoadError;
}

export interface CommercialDataMap {
  blocks: CommercialPage<CommercialAccessBlock>;
  entitlements: CommercialPage<CommercialEntitlement>;
  ledger: CommercialPage<CreativePointLedgerEntry>;
  catalog: CommercialPage<CommercialCatalogItem>;
  orders: CommercialPage<CommercialOrderItem>;
  rates: CommercialPage<CreativePointRateItem>;
  services: CommercialPage<ServiceFulfillmentItem>;
}

const initialDataStates = (): { [K in CommercialView]: CommercialDataState<CommercialDataMap[K]> } => ({
  blocks: { status: "idle" }, entitlements: { status: "idle" }, ledger: { status: "idle" }, catalog: { status: "idle" },
  orders: { status: "idle" }, rates: { status: "idle" }, services: { status: "idle" },
});

function errorEvidence(cause: unknown): CommercialLoadError {
  const error = cause as Partial<OpsRequestError> | undefined;
  return {
    message: describeOpsError(cause),
    code: typeof error?.code === "string" ? error.code : "COMMERCIAL_OPERATIONS_UNAVAILABLE",
    ...(typeof error?.requestId === "string" ? { requestId: error.requestId } : {}),
    ...(typeof error?.traceId === "string" ? { traceId: error.traceId } : {}),
    ...(typeof error?.httpStatus === "number" ? { httpStatus: error.httpStatus } : {}),
    ...(error?.details && typeof error.details === "object" ? { details: error.details } : {}),
    ...(Array.isArray(error?.nextActions) ? { nextActions: error.nextActions } : {}),
  };
}

export interface CommercialQueryState {
  view: CommercialView;
  record: string;
  status: string;
  query: string;
  page: number;
  sort: string;
  order: "ascend" | "descend" | "";
}

const positiveInteger = (value: string | null): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
};

export function readCommercialQuery(search: string): CommercialQueryState {
  const params = new URLSearchParams(search);
  const order = params.get("order");
  return {
    view: readCommercialView(search),
    record: params.get("record")?.trim() ?? "",
    status: params.get("status")?.trim() ?? "",
    query: params.get("q")?.trim() ?? "",
    page: positiveInteger(params.get("page")),
    sort: params.get("sort")?.trim() ?? "",
    order: order === "ascend" || order === "descend" ? order : "",
  };
}

export function readCommercialView(search: string): CommercialView {
  const value = new URLSearchParams(search).get("view");
  return commercialViews.includes(value as CommercialView) ? value as CommercialView : "blocks";
}

export function readCommercialTargetWorkspace(search: string, authorization: AuthorizationProjection): string {
  if (typeof search === "string") {
    const requested = new URLSearchParams(search).get("workspace")?.trim();
    if (requested) return requested;
  }
  return authorization.scope.kind === "workspace" || authorization.scope.kind === "controlled_support"
    ? authorization.scope.id?.trim() ?? ""
    : "";
}

export function commercialViewUrl(location: Pick<Location, "pathname" | "search" | "hash">, view: CommercialView): string {
  const params = new URLSearchParams(location.search);
  params.set("view", view);
  params.delete("record");
  const query = params.toString();
  return `${location.pathname}${query ? `?${query}` : ""}${location.hash}`;
}

export function commercialQueryUrl(
  location: Pick<Location, "pathname" | "search" | "hash">,
  patch: Partial<CommercialQueryState>,
): string {
  const params = new URLSearchParams(location.search);
  const values: Array<[keyof CommercialQueryState, string, string]> = [
    ["view", "view", patch.view ?? ""], ["record", "record", patch.record ?? ""],
    ["status", "status", patch.status ?? ""], ["query", "q", patch.query ?? ""],
    ["sort", "sort", patch.sort ?? ""], ["order", "order", patch.order ?? ""],
  ];
  for (const [field, key, value] of values) {
    if (!(field in patch)) continue;
    if (value) params.set(key, value); else params.delete(key);
  }
  if (patch.page !== undefined) {
    if (patch.page > 1) params.set("page", String(patch.page)); else params.delete("page");
  }
  const query = params.toString();
  return `${location.pathname}${query ? `?${query}` : ""}${location.hash}`;
}

export function useCommercialOperations(
  authorization: AuthorizationProjection,
  client: CommercialOperationsClient = commercialOperationsClient,
) {
  const [queryState, setQueryState] = useState<CommercialQueryState>(() => typeof window === "undefined"
    ? readCommercialQuery("") : readCommercialQuery(window.location.search));
  const view = queryState.view;
  const [summary, setSummary] = useState<CommercialDataState<CommercialAccessSummary>>({ status: "idle" });
  const [data, setData] = useState(initialDataStates);
  const requestRef = useRef(0);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const summaryRequestRef = useRef(0);
  const summaryControllerRef = useRef<AbortController | undefined>(undefined);
  const privateSkuReadable = authorization.can(commercialCapabilities.privateSkuRead);
  const targetWorkspaceId = readCommercialTargetWorkspace(typeof window === "undefined" ? "" : window.location.search, authorization);

  const setView = useCallback((next: CommercialView) => {
    setQueryState((current) => ({ ...current, view: next, record: "", status: "", query: "", page: 1, sort: "", order: "" }));
    if (typeof window !== "undefined") window.history.pushState({}, "", commercialQueryUrl(window.location, { view: next, record: "", status: "", query: "", page: 1, sort: "", order: "" }));
  }, []);

  const setQuery = useCallback((patch: Partial<CommercialQueryState>, mode: "push" | "replace" = "push") => {
    setQueryState((current) => ({ ...current, ...patch }));
    if (typeof window === "undefined") return;
    window.history[mode === "replace" ? "replaceState" : "pushState"]({}, "", commercialQueryUrl(window.location, patch));
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onPopState = () => setQueryState(readCommercialQuery(window.location.search));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const sensitiveScopeRef = useRef(targetWorkspaceId);
  useEffect(() => {
    if (sensitiveScopeRef.current === targetWorkspaceId) return;
    sensitiveScopeRef.current = targetWorkspaceId;
    controllerRef.current?.abort();
    summaryControllerRef.current?.abort();
    requestRef.current += 1;
    summaryRequestRef.current += 1;
    setSummary({ status: "idle" });
    setData(initialDataStates());
    setQueryState((current) => ({ ...current, record: "", page: 1 }));
    if (typeof window !== "undefined") window.history.replaceState({}, "", commercialQueryUrl(window.location, { record: "", page: 1 }));
  }, [targetWorkspaceId]);

  const loadSummary = useCallback(async () => {
    summaryControllerRef.current?.abort();
    const request = ++summaryRequestRef.current;
    if (!authorization.can(commercialCapabilities.accessRead)) {
      setSummary({ status: "forbidden" });
      return;
    }
    const controller = new AbortController();
    summaryControllerRef.current = controller;
    setSummary({ status: "loading" });
    try {
      const result = await client.summary(targetWorkspaceId, controller.signal);
      if (request === summaryRequestRef.current) setSummary({ status: "ready", data: result });
    } catch (cause) {
      if (request === summaryRequestRef.current && !(cause instanceof DOMException && cause.name === "AbortError")) setSummary({ status: "error", error: errorEvidence(cause) });
    }
  }, [authorization, client, targetWorkspaceId]);

  const loadView = useCallback(async (target: CommercialView = view) => {
    const capability = commercialViewCapability[target];
    if (!authorization.can(capability)) {
      controllerRef.current?.abort();
      requestRef.current += 1;
      setData((current) => ({ ...current, [target]: { status: "forbidden" } }));
      return;
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const request = ++requestRef.current;
    setData((current) => ({ ...current, [target]: { status: "loading", data: current[target].data } }));
    try {
      let result: CommercialDataMap[CommercialView];
      if (target === "catalog") {
        const catalog = await client.catalog(targetWorkspaceId, privateSkuReadable, controller.signal);
        result = privateSkuReadable ? catalog : { ...catalog, items: catalog.items.filter((item) => item.visibility !== "private") };
      } else {
        result = await client[target](targetWorkspaceId, controller.signal);
      }
      if (request !== requestRef.current) return;
      setData((current) => ({ ...current, [target]: { status: "ready", data: result } }));
    } catch (cause) {
      if (request !== requestRef.current || cause instanceof DOMException && cause.name === "AbortError") return;
      setData((current) => ({ ...current, [target]: { status: "error", data: current[target].data, error: errorEvidence(cause) } }));
    }
  }, [authorization, client, privateSkuReadable, targetWorkspaceId, view]);

  useEffect(() => {
    void loadSummary();
    return () => summaryControllerRef.current?.abort();
  }, [loadSummary]);

  useEffect(() => { void loadView(view); }, [loadView, view]);
  useEffect(() => () => controllerRef.current?.abort(), []);

  const permissions = useMemo(() => ({
    privateSkuReadable,
    canRecover: authorization.can(commercialCapabilities.accessRecover),
    canAdjustPoints: authorization.can(commercialCapabilities.pointAdjust),
    canDraftCatalog: authorization.can(commercialCapabilities.catalogDraft),
    canPublishCatalog: authorization.can(commercialCapabilities.catalogPublish),
    canGrantPrivateSku: authorization.can(commercialCapabilities.privateSkuGrant),
    canReconcilePayment: authorization.can(commercialCapabilities.paymentReconcile),
    canDraftRate: authorization.can(commercialCapabilities.rateDraft),
    canApproveRate: authorization.can(commercialCapabilities.rateApprove),
    canWriteService: authorization.can(commercialCapabilities.serviceWrite),
  }), [authorization, privateSkuReadable]);

  return { view, setView, query: queryState, setQuery, summary, data, loadSummary, loadView, permissions };
}

export type CommercialOperationsController = ReturnType<typeof useCommercialOperations>;
