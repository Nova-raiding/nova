import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AssignSupportTicketCommand,
  CommentOnSupportTicketCommand,
  CreateSupportTicketCommand,
  SupportCrmExportContract,
  SupportTicketContract,
  SupportTicketEventContract,
  SupportTicketPageContract,
  SupportTicketPageCursor,
  SupportTicketPriority,
  SupportTicketStatus,
  TransitionSupportTicketCommand,
} from "../../../../packages/contracts/src/ops/support.js";

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
    query?: string;
    cursor?: SupportTicketPageCursor;
    limit: number;
  }): Promise<SupportTicketPageContract>;
  get(workspaceId: string, ticketId: string): Promise<SupportTicketDetail | undefined>;
  create(command: CreateSupportTicketCommand): Promise<SupportMutationResult>;
  assign(command: AssignSupportTicketCommand): Promise<SupportMutationResult>;
  transition(command: TransitionSupportTicketCommand): Promise<SupportMutationResult>;
  comment(command: CommentOnSupportTicketCommand): Promise<SupportMutationResult>;
  exportCrm(workspaceId: string): Promise<SupportCrmExportContract>;
}

export interface SupportFilters {
  query: string;
  status?: SupportTicketStatus;
  priority?: SupportTicketPriority;
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
  exportCrm(): Promise<SupportCrmExportContract>;
}

const errorMessage = (error: unknown) => error instanceof Error && error.message
  ? error.message
  : "客服数据操作失败，请重试。";

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
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const mutationRequest = useRef(0);

  const fetchPage = useCallback(async (nextCursor?: SupportTicketPageCursor, append = false) => {
    const request = ++listRequest.current;
    append ? setLoadingMore(true) : setLoading(true);
    setError("");
    try {
      const page = await client.list({
        workspaceId,
        ...(platformScope ? { platformScope: true } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.priority ? { priority: filters.priority } : {}),
        ...(filters.query.trim() ? { query: filters.query.trim() } : {}),
        ...(nextCursor ? { cursor: nextCursor } : {}),
        limit: 25,
      });
      if (request !== listRequest.current) return;
      setTickets(current => append
        ? [...current, ...page.items.filter(item => !current.some(existing => existing.id === item.id))]
        : page.items);
      setCursor(page.nextCursor);
    } catch (cause) {
      if (request === listRequest.current) setError(errorMessage(cause));
    } finally {
      if (request === listRequest.current) append ? setLoadingMore(false) : setLoading(false);
    }
  }, [client, filters.priority, filters.query, filters.status, platformScope, workspaceId]);

  const reload = useCallback(() => fetchPage(undefined, false), [fetchPage]);
  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    await fetchPage(cursor, true);
  }, [cursor, fetchPage, loadingMore]);

  const selectTicket = useCallback(async (ticketId: string) => {
    const request = ++detailRequest.current;
    setDetailLoading(true);
    setError("");
    try {
      const detail = await client.get(workspaceId, ticketId);
      if (request === detailRequest.current) {
        if (!detail) throw new Error("工单不存在或已无权访问。");
        setSelected(detail);
      }
    } catch (cause) {
      if (request === detailRequest.current) setError(errorMessage(cause));
    } finally {
      if (request === detailRequest.current) setDetailLoading(false);
    }
  }, [client, workspaceId]);

  const updateSelected = useCallback(async (operation: () => Promise<SupportMutationResult>) => {
    const request = ++mutationRequest.current;
    setMutating(true);
    setError("");
    try {
      const result = await operation();
      if (request !== mutationRequest.current) return;
      setTickets(current => current.map(ticket => ticket.id === result.ticket.id ? result.ticket : ticket));
      const detail = await client.get(workspaceId, result.ticket.id);
      if (request === mutationRequest.current && detail) setSelected(detail);
    } catch (cause) {
      if (request === mutationRequest.current) setError(errorMessage(cause));
      throw cause;
    } finally {
      if (request === mutationRequest.current) setMutating(false);
    }
  }, [client, workspaceId]);

  const create = useCallback(async (command: Omit<CreateSupportTicketCommand, "workspaceId">) => {
    const request = ++mutationRequest.current;
    setMutating(true);
    setError("");
    try {
      const result = await client.create({ ...command, workspaceId });
      if (request !== mutationRequest.current) return;
      await reload();
      if (request !== mutationRequest.current) return;
      await selectTicket(result.ticket.id);
    } catch (cause) {
      if (request === mutationRequest.current) setError(errorMessage(cause));
      throw cause;
    } finally {
      if (request === mutationRequest.current) setMutating(false);
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

  useEffect(() => {
    listRequest.current += 1;
    detailRequest.current += 1;
    mutationRequest.current += 1;
    setTickets([]);
    setSelected(undefined);
    setCursor(undefined);
    setError("");
    setLoading(false);
    setLoadingMore(false);
    setDetailLoading(false);
    setMutating(false);
  }, [workspaceId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void reload(), 250);
    return () => window.clearTimeout(timeout);
  }, [reload]);

  return {
    workspaceId, tickets, selected, filters, loading, loadingMore, detailLoading, mutating, error,
    hasMore: Boolean(cursor), setFilters, reload, loadMore, selectTicket,
    clearSelection: () => { detailRequest.current += 1; setSelected(undefined); },
    create, assign, transition, comment,
    exportCrm: () => client.exportCrm(workspaceId),
  };
}
