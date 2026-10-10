import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AssignSupportTicketCommand,
  CommentOnSupportTicketCommand,
  CreateSupportTicketCommand,
  SupportTicketContract,
  SupportTicketEventContract,
  SupportTicketPageContract,
  SupportTicketPageCursor,
  SupportTicketPriority,
  SupportTicketStatus,
  SupportSlaState,
  TransitionSupportTicketCommand,
} from "../../../../packages/contracts/src/ops/support.js";
import type { SupportSlaCorrectionApprovalProgress, SupportSlaCorrectionDecision, SupportSlaCorrectionRun, SupportSlaMonthlyReport } from "../../../../packages/contracts/src/ops/support-sla-report.js";
import type { OpsRpcOptions } from "../api/opsClient.js";

export interface SupportTicketDetail {
  ticket: SupportTicketContract;
  events: SupportTicketEventContract[];
}

export interface SupportMutationResult {
  ticket: SupportTicketContract;
  event: SupportTicketEventContract;
  replayed: boolean;
}

export interface SupportDetailRefreshError {
  ticketId: string;
  message: string;
}

export interface SupportDetailError {
  ticketId: string;
  message: string;
}

export interface SupportDomainClient {
  list(input: {
    workspaceId: string;
    platformScope?: boolean;
    status?: SupportTicketStatus;
    priority?: SupportTicketPriority;
    slaState?: SupportSlaState;
    assigneeId?: string;
    customerId?: string;
    query?: string;
    cursor?: SupportTicketPageCursor;
    limit: number;
  }): Promise<SupportTicketPageContract>;
  get(workspaceId: string, ticketId: string): Promise<SupportTicketDetail | undefined>;
  create(command: CreateSupportTicketCommand): Promise<SupportMutationResult>;
  assign(command: AssignSupportTicketCommand): Promise<SupportMutationResult>;
  transition(command: TransitionSupportTicketCommand): Promise<SupportMutationResult>;
  comment(command: CommentOnSupportTicketCommand): Promise<SupportMutationResult>;
  report(input: { workspaceId: string; periodStart: string; periodEnd: string; cutoffAt: string; reportId?: string }): Promise<SupportSlaMonthlyReport>;
  createCorrection(input: { workspaceId: string; originalReportId: string; periodStart: string; periodEnd: string; cutoffAt: string; reason: string; idempotencyKey: string }): Promise<SupportSlaCorrectionRun | { status: "no_change"; originalReportId: string; checksum: string }>;
  // The `approval` obligation on the correction decision is resolved
  // server-side from the token grant alone (verifiedApprovalActor in
  // apps/api/src/server.ts), so the approver's token travels as an
  // OpsRpcOptions header. Without the parameter here the transport arg on
  // opsDomainClients.decideCorrection was unreachable from any typed caller,
  // which made the 批准/拒绝 controls dead under requiresStrictAuth().
  decideCorrection(input: { workspaceId: string; correctionId: string; decision: "approved" | "rejected"; reason: string; idempotencyKey: string }, options?: OpsRpcOptions): Promise<SupportSlaCorrectionDecision | SupportSlaCorrectionApprovalProgress>;
}

export interface SupportFilters {
  query: string;
  customerId?: string;
  status?: SupportTicketStatus;
  priority?: SupportTicketPriority;
  slaState?: SupportSlaState;
  assigneeId?: string;
}

export interface SupportDomainModel {
  workspaceId: string;
  tickets: SupportTicketContract[];
  selected?: SupportTicketDetail;
  filters: SupportFilters;
  loading: boolean;
  loadingMore: boolean;
  detailLoading: boolean;
  mutating: boolean;
  error: string;
  detailError?: SupportDetailError;
  detailRefreshError?: SupportDetailRefreshError;
  hasMore: boolean;
  scanTruncated?: boolean;
  setFilters(filters: SupportFilters): void;
  reload(): Promise<void>;
  loadMore(): Promise<void>;
  selectTicket(ticketId: string): Promise<void>;
  clearSelection(): void;
  create(command: Omit<CreateSupportTicketCommand, "workspaceId">): Promise<void>;
  assign(assigneeId: string): Promise<void>;
  transition(status: SupportTicketStatus, reason: string): Promise<void>;
  comment(body: string, visibility: "internal" | "customer"): Promise<void>;
  report?: SupportSlaMonthlyReport;
  reportLoading: boolean;
  reportStale?: boolean;
  reportError?: string;
  loadReport(input: { periodStart: string; periodEnd: string; cutoffAt: string; reportId?: string }): Promise<void>;
  correction?: SupportSlaCorrectionRun | { status: "no_change"; originalReportId: string; checksum: string };
  correctionDecision?: SupportSlaCorrectionDecision | SupportSlaCorrectionApprovalProgress;
  correctionLoading?: boolean;
  createCorrection?: (reason: string) => Promise<void>;
  // The token is optional so existing callers keep compiling, but under
  // requiresStrictAuth() a decision submitted without it is rejected by the
  // server, so the UI must always supply it.
  decideCorrection?: (decision: "approved" | "rejected", reason: string, approvalToken?: string) => Promise<void>;
}

const errorMessage = (error: unknown) => error instanceof Error && error.message
  ? error.message
  : "客服数据操作失败，请重试。";

export const isCurrentSupportRequest = (
  request: number,
  currentRequest: number,
  requestWorkspaceId: string,
  currentWorkspaceId: string,
) => request === currentRequest && requestWorkspaceId === currentWorkspaceId;

export function useSupportDomain(client: SupportDomainClient, workspaceId: string, platformScope = false): SupportDomainModel {
  const [tickets, setTickets] = useState<SupportTicketContract[]>([]);
  const [selected, setSelected] = useState<SupportTicketDetail>();
  const [filters, setFiltersState] = useState<SupportFilters>({ query: "" });
  const [cursor, setCursor] = useState<SupportTicketPageCursor>();
  const [scanTruncated, setScanTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState<SupportDetailError>();
  const [detailRefreshError, setDetailRefreshError] = useState<SupportDetailRefreshError>();
  const [report, setReport] = useState<SupportSlaMonthlyReport>();
  const [reportLoading, setReportLoading] = useState(false);
  const [reportStale, setReportStale] = useState(false);
  const reportStaleRef = useRef(false);
  const [reportError, setReportError] = useState("");
  const [correction, setCorrection] = useState<SupportSlaCorrectionRun | { status: "no_change"; originalReportId: string; checksum: string }>();
  const [correctionDecision, setCorrectionDecision] = useState<SupportSlaCorrectionDecision | SupportSlaCorrectionApprovalProgress>();
  const [correctionLoading, setCorrectionLoading] = useState(false);
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const mutationRequest = useRef(0);
  const reportRequest = useRef(0);
  const correctionRequest = useRef(0);
  const correctionSubmissionRef = useRef<{ fingerprint: string; idempotencyKey: string } | undefined>(undefined);
  const correctionDecisionSubmissionRef = useRef<{ fingerprint: string; idempotencyKey: string } | undefined>(undefined);
  const correctionDecisionInFlightRef = useRef<Promise<void> | undefined>(undefined);
  // Keep a stable key for each unresolved support mutation intent. A lost
  // response must be replayed with the original key so the repository can
  // return its committed event instead of creating another one.
  const supportMutationIntents = useRef(new Map<string, { fingerprint: string; idempotencyKey: string }>());
  const filterRefreshPending = useRef(false);
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;

  const fetchPage = useCallback(async (nextCursor?: SupportTicketPageCursor, append = false) => {
    if (!append) filterRefreshPending.current = false;
    const request = ++listRequest.current;
    const requestWorkspaceId = workspaceId;
    append ? setLoadingMore(true) : setLoading(true);
    setError("");
    try {
      const page = await client.list({
        workspaceId,
        ...(platformScope ? { platformScope: true } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.priority ? { priority: filters.priority } : {}),
        ...(filters.slaState ? { slaState: filters.slaState } : {}),
        ...(filters.assigneeId ? { assigneeId: filters.assigneeId } : {}),
        ...(filters.query.trim() ? { query: filters.query.trim() } : {}),
        ...(filters.customerId?.trim() ? { customerId: filters.customerId.trim() } : {}),
        ...(nextCursor ? { cursor: nextCursor } : {}),
        limit: 20,
      });
      if (!isCurrentSupportRequest(request, listRequest.current, requestWorkspaceId, workspaceRef.current)) return;
      setTickets(current => append
        ? [...current, ...page.items.filter(item => !current.some(existing => existing.id === item.id))]
        : page.items);
      setCursor(page.nextCursor);
      setScanTruncated(Boolean(page.scanTruncated));
    } catch (cause) {
      if (isCurrentSupportRequest(request, listRequest.current, requestWorkspaceId, workspaceRef.current)) setError(errorMessage(cause));
    } finally {
      if (isCurrentSupportRequest(request, listRequest.current, requestWorkspaceId, workspaceRef.current)) append ? setLoadingMore(false) : setLoading(false);
    }
  }, [client, filters.assigneeId, filters.customerId, filters.priority, filters.query, filters.slaState, filters.status, platformScope, workspaceId]);

  const reload = useCallback(() => fetchPage(undefined, false), [fetchPage]);
  const setFilters = useCallback((nextFilters: SupportFilters) => {
    // Invalidate the old cursor and any in-flight page as soon as a filter
    // changes. The debounced first page has not started yet, so retaining the
    // previous cursor here would let a click append old-cursor results under
    // the new query.
    filterRefreshPending.current = true;
    listRequest.current += 1;
    setTickets([]);
    setCursor(undefined);
    setScanTruncated(false);
    setLoading(true);
    setLoadingMore(false);
    setFiltersState(nextFilters);
  }, []);
  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore || filterRefreshPending.current) return;
    await fetchPage(cursor, true);
  }, [cursor, fetchPage, loadingMore]);

  const selectTicket = useCallback(async (ticketId: string) => {
    const request = ++detailRequest.current;
    const requestWorkspaceId = workspaceId;
    // Do not leave an earlier ticket visible if this selection fails. Once
    // loading ends, a stale detail would otherwise look like the clicked row.
    setSelected(undefined);
    setDetailError(undefined);
    setDetailRefreshError(undefined);
    setDetailLoading(true);
    try {
      const detail = await client.get(workspaceId, ticketId);
      if (isCurrentSupportRequest(request, detailRequest.current, requestWorkspaceId, workspaceRef.current)) {
        if (!detail) throw new Error("工单不存在或已无权访问。");
        setSelected(detail);
      }
    } catch (cause) {
      if (isCurrentSupportRequest(request, detailRequest.current, requestWorkspaceId, workspaceRef.current)) setDetailError({ ticketId, message: errorMessage(cause) });
    } finally {
      if (isCurrentSupportRequest(request, detailRequest.current, requestWorkspaceId, workspaceRef.current)) setDetailLoading(false);
    }
  }, [client, workspaceId]);

  const updateSelected = useCallback(async (operation: () => Promise<SupportMutationResult>) => {
    const request = ++mutationRequest.current;
    const requestWorkspaceId = workspaceId;
    const detailSelectionRequest = detailRequest.current;
    setMutating(true);
    setError("");
    setDetailRefreshError(undefined);
    let result: SupportMutationResult;
    try {
      result = await operation();
    } catch (cause) {
      if (isCurrentSupportRequest(request, mutationRequest.current, requestWorkspaceId, workspaceRef.current)) {
        setError(errorMessage(cause));
        setMutating(false);
      }
      throw cause;
    }
    if (!isCurrentSupportRequest(request, mutationRequest.current, requestWorkspaceId, workspaceRef.current)) return;
    setTickets(current => current.map(ticket => ticket.id === result.ticket.id ? result.ticket : ticket));
    if (detailRequest.current !== detailSelectionRequest) {
      // The operator closed the detail or selected another ticket while the
      // write was pending. Keep the queue projection current, but do not let
      // this write's follow-up read reopen or overwrite their current choice.
      setMutating(false);
      return;
    }
    // The mutation response already carries the committed projection and its
    // immutable event. Keep those visible even if the follow-up detail read is
    // temporarily unavailable, so a transport read failure cannot be mistaken
    // for a failed write and retried as a new operation.
    setSelected(current => current?.ticket.id === result.ticket.id ? {
      ticket: result.ticket,
      events: [...current.events.filter(event => event.id !== result.event.id), result.event].sort((left, right) => left.sequence - right.sequence),
    } : current);
    // The write is complete and its response is now displayed. Do not keep the
    // modal's confirm button loading while a best-effort detail refresh runs;
    // the operator must be able to close or navigate away from the detail.
    setMutating(false);
    void client.get(workspaceId, result.ticket.id).then(detail => {
      if (!isCurrentSupportRequest(request, mutationRequest.current, requestWorkspaceId, workspaceRef.current)
        || detailRequest.current !== detailSelectionRequest) return;
      if (detail) setSelected(current => current?.ticket.id === result.ticket.id ? detail : current);
      else if (selected?.ticket.id === result.ticket.id) setDetailRefreshError({ ticketId: result.ticket.id, message: "工单已保存，但详情刷新未返回数据；当前显示写入结果。可以重试读取详情。" });
    }).catch(cause => {
      if (isCurrentSupportRequest(request, mutationRequest.current, requestWorkspaceId, workspaceRef.current)
        && detailRequest.current === detailSelectionRequest && selected?.ticket.id === result.ticket.id) {
        setDetailRefreshError({ ticketId: result.ticket.id, message: `工单已保存，但详情刷新失败：${errorMessage(cause)}` });
      }
    });
  }, [client, selected, workspaceId]);

  const supportMutationKey = (kind: string, fingerprint: string) => {
    const current = supportMutationIntents.current.get(kind);
    if (current?.fingerprint === fingerprint) return current.idempotencyKey;
    const intent = { fingerprint, idempotencyKey: crypto.randomUUID() };
    supportMutationIntents.current.set(kind, intent);
    return intent.idempotencyKey;
  };
  const resolveSupportMutationKey = (kind: string, fingerprint: string, idempotencyKey: string) => {
    const current = supportMutationIntents.current.get(kind);
    if (current?.fingerprint === fingerprint && current.idempotencyKey === idempotencyKey) supportMutationIntents.current.delete(kind);
  };

  const create = useCallback(async (command: Omit<CreateSupportTicketCommand, "workspaceId">) => {
    const request = ++mutationRequest.current;
    const requestWorkspaceId = workspaceId;
    setMutating(true);
    setError("");
    let result: SupportMutationResult;
    try {
      result = await client.create({ ...command, workspaceId });
    } catch (cause) {
      // Creation errors belong to the open create dialog. Feeding them into the
      // shared list/detail error channel mislabels a failed mutation as a queue
      // read outage and places the only feedback behind the modal.
      if (isCurrentSupportRequest(request, mutationRequest.current, requestWorkspaceId, workspaceRef.current)) setMutating(false);
      throw cause;
    }
    try {
      if (!isCurrentSupportRequest(request, mutationRequest.current, requestWorkspaceId, workspaceRef.current)) return;
      // The create mutation is committed at this point. Refresh/detail failures
      // have their own shared error state and must not make the modal tell the
      // operator that creation failed (which could prompt a duplicate retry).
      await reload();
      if (!isCurrentSupportRequest(request, mutationRequest.current, requestWorkspaceId, workspaceRef.current)) return;
      await selectTicket(result.ticket.id);
    } finally {
      if (isCurrentSupportRequest(request, mutationRequest.current, requestWorkspaceId, workspaceRef.current)) setMutating(false);
    }
  }, [client, reload, selectTicket, workspaceId]);

  const assign = useCallback(async (assigneeId: string) => {
    if (!selected) return;
    const fingerprint = JSON.stringify([workspaceId, selected.ticket.id, selected.ticket.revision, assigneeId]);
    const idempotencyKey = supportMutationKey("assign", fingerprint);
    await updateSelected(() => client.assign({
      workspaceId, ticketId: selected.ticket.id, assigneeId,
      expectedRevision: selected.ticket.revision, idempotencyKey,
    }));
    resolveSupportMutationKey("assign", fingerprint, idempotencyKey);
  }, [client, selected, updateSelected, workspaceId]);

  const transition = useCallback(async (status: SupportTicketStatus, reason: string) => {
    if (!selected) return;
    const fingerprint = JSON.stringify([workspaceId, selected.ticket.id, selected.ticket.revision, status, reason]);
    const idempotencyKey = supportMutationKey("transition", fingerprint);
    await updateSelected(() => client.transition({
      workspaceId, ticketId: selected.ticket.id, status, reason,
      expectedRevision: selected.ticket.revision, idempotencyKey,
    }));
    resolveSupportMutationKey("transition", fingerprint, idempotencyKey);
  }, [client, selected, updateSelected, workspaceId]);

  const comment = useCallback(async (body: string, visibility: "internal" | "customer") => {
    if (!selected) return;
    const fingerprint = JSON.stringify([workspaceId, selected.ticket.id, selected.ticket.revision, body, visibility]);
    const idempotencyKey = supportMutationKey("comment", fingerprint);
    await updateSelected(() => client.comment({
      workspaceId, ticketId: selected.ticket.id, body, visibility,
      expectedRevision: selected.ticket.revision, idempotencyKey,
    }));
    resolveSupportMutationKey("comment", fingerprint, idempotencyKey);
  }, [client, selected, updateSelected, workspaceId]);

  const loadReport = useCallback(async (input: { periodStart: string; periodEnd: string; cutoffAt: string; reportId?: string }) => {
    const request = ++reportRequest.current;
    const requestWorkspaceId = workspaceId;
    reportStaleRef.current = true;
    setReportLoading(true);
    setReportStale(true);
    setReportError("");
    // Corrections are bound to an immutable report ID. A refreshed/cross-period
    // snapshot must not inherit correction state from the snapshot it replaces.
    correctionRequest.current += 1;
    setCorrection(undefined);
    setCorrectionDecision(undefined);
    setCorrectionLoading(false);
    try {
      const loaded = await client.report({ workspaceId, ...input });
      if (isCurrentSupportRequest(request, reportRequest.current, requestWorkspaceId, workspaceRef.current)) {
        setReport(loaded);
        reportStaleRef.current = false;
        setReportStale(false);
      }
    } catch (cause) {
      if (isCurrentSupportRequest(request, reportRequest.current, requestWorkspaceId, workspaceRef.current)) {
        const message = errorMessage(cause);
        setReportError(message);
      }
    } finally {
      if (isCurrentSupportRequest(request, reportRequest.current, requestWorkspaceId, workspaceRef.current)) setReportLoading(false);
    }
  }, [client, workspaceId]);

  const createCorrection = useCallback(async (reason: string) => {
    if (!report) throw new Error("请先生成月报，再创建 correction。");
    if (report.workspaceId !== workspaceId || reportLoading || reportStale || reportStaleRef.current) throw new Error("报告正在刷新、属于其他工作区或刷新失败；请先成功生成当前报告，再创建 correction。");
    const request = ++correctionRequest.current;
    const requestWorkspaceId = workspaceId;
    const fingerprint = JSON.stringify([workspaceId, report.reportId, report.periodStart, report.periodEnd, report.cutoffAt, reason]);
    if (correctionSubmissionRef.current?.fingerprint !== fingerprint) {
      correctionSubmissionRef.current = { fingerprint, idempotencyKey: crypto.randomUUID() };
    }
    const idempotencyKey = correctionSubmissionRef.current.idempotencyKey;
    setCorrectionLoading(true);
    setError("");
    try {
      const loaded = await client.createCorrection({ workspaceId, originalReportId: report.reportId, periodStart: report.periodStart, periodEnd: report.periodEnd, cutoffAt: report.cutoffAt, reason, idempotencyKey });
      if (isCurrentSupportRequest(request, correctionRequest.current, requestWorkspaceId, workspaceRef.current)) {
        setCorrection(loaded);
        if (correctionSubmissionRef.current?.idempotencyKey === idempotencyKey) correctionSubmissionRef.current = undefined;
      }
    } catch (cause) {
      if (isCurrentSupportRequest(request, correctionRequest.current, requestWorkspaceId, workspaceRef.current)) setError(errorMessage(cause));
      throw cause;
    } finally {
      if (isCurrentSupportRequest(request, correctionRequest.current, requestWorkspaceId, workspaceRef.current)) setCorrectionLoading(false);
    }
  }, [client, report, reportLoading, reportStale, workspaceId]);

  const decideCorrection = useCallback((decision: "approved" | "rejected", reason: string, approvalToken?: string) => {
    // A synchronous single-flight lock covers rapid duplicate submits before
    // React has rendered the loading state. Reuse the same promise so duplicate
    // callers keep the dialog open if the actual request fails.
    if (correctionDecisionInFlightRef.current) return correctionDecisionInFlightRef.current;
    if (!correction || correction.status === "no_change") return Promise.reject(new Error("当前没有待审批 correction。"));
    const request = ++correctionRequest.current;
    const requestWorkspaceId = workspaceId;
    const fingerprint = JSON.stringify([workspaceId, correction.correctionId, decision, reason]);
    if (correctionDecisionSubmissionRef.current?.fingerprint !== fingerprint) {
      correctionDecisionSubmissionRef.current = { fingerprint, idempotencyKey: crypto.randomUUID() };
    }
    const idempotencyKey = correctionDecisionSubmissionRef.current.idempotencyKey;
    setCorrectionLoading(true);
    setError("");
    const submission = (async () => {
      try {
        // The token rides in the second argument (OpsRpcOptions) so the console
        // emits it as the x-authorization-approval-token header, never as an rpc
        // param: a param field would recreate the caller-supplied `approved_by`
        // claim the token exists to replace, and a whitespace-only token trims to
        // empty here so no blank header is sent.
        const loaded = await client.decideCorrection({ workspaceId, correctionId: correction.correctionId, decision, reason, idempotencyKey }, { authorizationApprovalToken: approvalToken?.trim() });
        if (isCurrentSupportRequest(request, correctionRequest.current, requestWorkspaceId, workspaceRef.current)) {
          setCorrectionDecision(loaded);
          if (correctionDecisionSubmissionRef.current?.idempotencyKey === idempotencyKey) correctionDecisionSubmissionRef.current = undefined;
        }
      } catch (cause) {
        if (isCurrentSupportRequest(request, correctionRequest.current, requestWorkspaceId, workspaceRef.current)) setError(errorMessage(cause));
        throw cause;
      } finally {
        if (isCurrentSupportRequest(request, correctionRequest.current, requestWorkspaceId, workspaceRef.current)) setCorrectionLoading(false);
      }
    })();
    let tracked: Promise<void>;
    tracked = submission.finally(() => { if (correctionDecisionInFlightRef.current === tracked) correctionDecisionInFlightRef.current = undefined; });
    correctionDecisionInFlightRef.current = tracked;
    return tracked;
  }, [client, correction, workspaceId]);

  useEffect(() => {
    listRequest.current += 1;
    detailRequest.current += 1;
    mutationRequest.current += 1;
    reportRequest.current += 1;
    correctionRequest.current += 1;
    setTickets([]);
    setSelected(undefined);
    setDetailError(undefined);
    setDetailRefreshError(undefined);
    setCursor(undefined);
    setScanTruncated(false);
    setError("");
    setLoading(false);
    setLoadingMore(false);
    setDetailLoading(false);
    setMutating(false);
    setReport(undefined);
    setReportLoading(false);
    setReportStale(false);
    setReportError("");
    setCorrection(undefined);
    setCorrectionDecision(undefined);
    setCorrectionLoading(false);
  }, [workspaceId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void reload(), 250);
    return () => window.clearTimeout(timeout);
  }, [reload]);

  return {
    workspaceId, tickets, selected, filters, loading, loadingMore, detailLoading, mutating, error, detailError, detailRefreshError, report, reportLoading, reportStale, reportError,
    hasMore: Boolean(cursor), scanTruncated, setFilters, reload, loadMore, selectTicket,
    clearSelection: () => { detailRequest.current += 1; setSelected(undefined); setDetailError(undefined); setDetailRefreshError(undefined); },
    create, assign, transition, comment,
    loadReport, correction, correctionDecision, correctionLoading, createCorrection, decideCorrection,
  };
}
