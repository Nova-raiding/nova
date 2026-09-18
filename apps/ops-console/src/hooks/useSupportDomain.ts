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

export interface SupportTicketDetail {
  ticket: SupportTicketContract;
  events: SupportTicketEventContract[];
}

export interface SupportMutationResult {
  ticket: SupportTicketContract;
  event: SupportTicketEventContract;
  replayed: boolean;
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
  decideCorrection(input: { workspaceId: string; correctionId: string; decision: "approved" | "rejected"; reason: string; idempotencyKey: string }): Promise<SupportSlaCorrectionDecision | SupportSlaCorrectionApprovalProgress>;
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
  hasMore: boolean;
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
  loadReport(input: { periodStart: string; periodEnd: string; cutoffAt: string; reportId?: string }): Promise<void>;
  correction?: SupportSlaCorrectionRun | { status: "no_change"; originalReportId: string; checksum: string };
  correctionDecision?: SupportSlaCorrectionDecision | SupportSlaCorrectionApprovalProgress;
  correctionLoading?: boolean;
  createCorrection?: (reason: string) => Promise<void>;
  decideCorrection?: (decision: "approved" | "rejected", reason: string) => Promise<void>;
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
  const [filters, setFilters] = useState<SupportFilters>({ query: "" });
  const [cursor, setCursor] = useState<SupportTicketPageCursor>();
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<SupportSlaMonthlyReport>();
  const [reportLoading, setReportLoading] = useState(false);
  const [correction, setCorrection] = useState<SupportSlaCorrectionRun | { status: "no_change"; originalReportId: string; checksum: string }>();
  const [correctionDecision, setCorrectionDecision] = useState<SupportSlaCorrectionDecision | SupportSlaCorrectionApprovalProgress>();
  const [correctionLoading, setCorrectionLoading] = useState(false);
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const mutationRequest = useRef(0);
  const reportRequest = useRef(0);
  const correctionRequest = useRef(0);
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;

  const fetchPage = useCallback(async (nextCursor?: SupportTicketPageCursor, append = false) => {
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
    } catch (cause) {
      if (isCurrentSupportRequest(request, listRequest.current, requestWorkspaceId, workspaceRef.current)) setError(errorMessage(cause));
    } finally {
      if (isCurrentSupportRequest(request, listRequest.current, requestWorkspaceId, workspaceRef.current)) append ? setLoadingMore(false) : setLoading(false);
    }
  }, [client, filters.assigneeId, filters.customerId, filters.priority, filters.query, filters.slaState, filters.status, platformScope, workspaceId]);

  const reload = useCallback(() => fetchPage(undefined, false), [fetchPage]);
  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    await fetchPage(cursor, true);
  }, [cursor, fetchPage, loadingMore]);

  const selectTicket = useCallback(async (ticketId: string) => {
    const request = ++detailRequest.current;
    const requestWorkspaceId = workspaceId;
    setDetailLoading(true);
    setError("");
    try {
      const detail = await client.get(workspaceId, ticketId);
      if (isCurrentSupportRequest(request, detailRequest.current, requestWorkspaceId, workspaceRef.current)) {
        if (!detail) throw new Error("工单不存在或已无权访问。");
        setSelected(detail);
      }
    } catch (cause) {
      if (isCurrentSupportRequest(request, detailRequest.current, requestWorkspaceId, workspaceRef.current)) setError(errorMessage(cause));
    } finally {
      if (isCurrentSupportRequest(request, detailRequest.current, requestWorkspaceId, workspaceRef.current)) setDetailLoading(false);
    }
  }, [client, workspaceId]);

  const updateSelected = useCallback(async (operation: () => Promise<SupportMutationResult>) => {
    const request = ++mutationRequest.current;
    const requestWorkspaceId = workspaceId;
    setMutating(true);
    setError("");
    try {
      const result = await operation();
      if (!isCurrentSupportRequest(request, mutationRequest.current, requestWorkspaceId, workspaceRef.current)) return;
      setTickets(current => current.map(ticket => ticket.id === result.ticket.id ? result.ticket : ticket));
      const detail = await client.get(workspaceId, result.ticket.id);
      if (isCurrentSupportRequest(request, mutationRequest.current, requestWorkspaceId, workspaceRef.current) && detail) setSelected(detail);
    } catch (cause) {
      if (isCurrentSupportRequest(request, mutationRequest.current, requestWorkspaceId, workspaceRef.current)) setError(errorMessage(cause));
      throw cause;
    } finally {
      if (isCurrentSupportRequest(request, mutationRequest.current, requestWorkspaceId, workspaceRef.current)) setMutating(false);
    }
  }, [client, workspaceId]);

  const create = useCallback(async (command: Omit<CreateSupportTicketCommand, "workspaceId">) => {
    const request = ++mutationRequest.current;
    const requestWorkspaceId = workspaceId;
    setMutating(true);
    setError("");
    try {
      const result = await client.create({ ...command, workspaceId });
      if (!isCurrentSupportRequest(request, mutationRequest.current, requestWorkspaceId, workspaceRef.current)) return;
      await reload();
      if (!isCurrentSupportRequest(request, mutationRequest.current, requestWorkspaceId, workspaceRef.current)) return;
      await selectTicket(result.ticket.id);
    } catch (cause) {
      if (isCurrentSupportRequest(request, mutationRequest.current, requestWorkspaceId, workspaceRef.current)) setError(errorMessage(cause));
      throw cause;
    } finally {
      if (isCurrentSupportRequest(request, mutationRequest.current, requestWorkspaceId, workspaceRef.current)) setMutating(false);
    }
  }, [client, reload, selectTicket, workspaceId]);

  const assign = useCallback(async (assigneeId: string) => {
    if (!selected) return;
    await updateSelected(() => client.assign({
      workspaceId, ticketId: selected.ticket.id, assigneeId,
      expectedRevision: selected.ticket.revision, idempotencyKey: crypto.randomUUID(),
    }));
  }, [client, selected, updateSelected, workspaceId]);

  const transition = useCallback(async (status: SupportTicketStatus, reason: string) => {
    if (!selected) return;
    await updateSelected(() => client.transition({
      workspaceId, ticketId: selected.ticket.id, status, reason,
      expectedRevision: selected.ticket.revision, idempotencyKey: crypto.randomUUID(),
    }));
  }, [client, selected, updateSelected, workspaceId]);

  const comment = useCallback(async (body: string, visibility: "internal" | "customer") => {
    if (!selected) return;
    await updateSelected(() => client.comment({
      workspaceId, ticketId: selected.ticket.id, body, visibility,
      expectedRevision: selected.ticket.revision, idempotencyKey: crypto.randomUUID(),
    }));
  }, [client, selected, updateSelected, workspaceId]);

  const loadReport = useCallback(async (input: { periodStart: string; periodEnd: string; cutoffAt: string; reportId?: string }) => {
    const request = ++reportRequest.current;
    const requestWorkspaceId = workspaceId;
    setReportLoading(true);
    setError("");
    try {
      const loaded = await client.report({ workspaceId, ...input });
      if (isCurrentSupportRequest(request, reportRequest.current, requestWorkspaceId, workspaceRef.current)) setReport(loaded);
    } catch (cause) {
      if (isCurrentSupportRequest(request, reportRequest.current, requestWorkspaceId, workspaceRef.current)) setError(errorMessage(cause));
    } finally {
      if (isCurrentSupportRequest(request, reportRequest.current, requestWorkspaceId, workspaceRef.current)) setReportLoading(false);
    }
  }, [client, workspaceId]);

  const createCorrection = useCallback(async (reason: string) => {
    if (!report) throw new Error("请先生成月报，再创建 correction。");
    const request = ++correctionRequest.current;
    const requestWorkspaceId = workspaceId;
    setCorrectionLoading(true);
    setError("");
    try {
      const loaded = await client.createCorrection({ workspaceId, originalReportId: report.reportId, periodStart: report.periodStart, periodEnd: report.periodEnd, cutoffAt: report.cutoffAt, reason, idempotencyKey: crypto.randomUUID() });
      if (isCurrentSupportRequest(request, correctionRequest.current, requestWorkspaceId, workspaceRef.current)) setCorrection(loaded);
    } catch (cause) {
      if (isCurrentSupportRequest(request, correctionRequest.current, requestWorkspaceId, workspaceRef.current)) setError(errorMessage(cause));
      throw cause;
    } finally {
      if (isCurrentSupportRequest(request, correctionRequest.current, requestWorkspaceId, workspaceRef.current)) setCorrectionLoading(false);
    }
  }, [client, report, workspaceId]);

  const decideCorrection = useCallback(async (decision: "approved" | "rejected", reason: string) => {
    if (!correction || correction.status === "no_change") throw new Error("当前没有待审批 correction。");
    const request = ++correctionRequest.current;
    const requestWorkspaceId = workspaceId;
    setCorrectionLoading(true);
    setError("");
    try {
      const loaded = await client.decideCorrection({ workspaceId, correctionId: correction.correctionId, decision, reason, idempotencyKey: crypto.randomUUID() });
      if (isCurrentSupportRequest(request, correctionRequest.current, requestWorkspaceId, workspaceRef.current)) setCorrectionDecision(loaded);
    } catch (cause) {
      if (isCurrentSupportRequest(request, correctionRequest.current, requestWorkspaceId, workspaceRef.current)) setError(errorMessage(cause));
      throw cause;
    } finally {
      if (isCurrentSupportRequest(request, correctionRequest.current, requestWorkspaceId, workspaceRef.current)) setCorrectionLoading(false);
    }
  }, [client, correction, workspaceId]);

  useEffect(() => {
    listRequest.current += 1;
    detailRequest.current += 1;
    mutationRequest.current += 1;
    reportRequest.current += 1;
    correctionRequest.current += 1;
    setTickets([]);
    setSelected(undefined);
    setCursor(undefined);
    setError("");
    setLoading(false);
    setLoadingMore(false);
    setDetailLoading(false);
    setMutating(false);
    setReport(undefined);
    setReportLoading(false);
    setCorrection(undefined);
    setCorrectionDecision(undefined);
    setCorrectionLoading(false);
  }, [workspaceId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void reload(), 250);
    return () => window.clearTimeout(timeout);
  }, [reload]);

  return {
    workspaceId, tickets, selected, filters, loading, loadingMore, detailLoading, mutating, error, report, reportLoading,
    hasMore: Boolean(cursor), setFilters, reload, loadMore, selectTicket,
    clearSelection: () => { detailRequest.current += 1; setSelected(undefined); },
    create, assign, transition, comment,
    loadReport, correction, correctionDecision, correctionLoading, createCorrection, decideCorrection,
  };
}
