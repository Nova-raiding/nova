import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FinanceExport,
  FinanceRecordDetail,
  FinanceRecordKind,
  FinanceSearchPage,
  FinanceSearchQuery,
  FinanceSearchRecord,
} from "../../../../packages/contracts/src/ops/finance-search.js";

export interface FinanceSearchClient {
  search(query: FinanceSearchQuery, signal?: AbortSignal): Promise<FinanceSearchPage>;
  detail(input: { workspaceId: string; kind: FinanceRecordKind; id: string; expectedVersion: string; snapshotAt: string }, signal?: AbortSignal): Promise<FinanceRecordDetail>;
  exportCsv(query: FinanceSearchQuery, signal?: AbortSignal): Promise<FinanceExport>;
}

export interface FinanceSearchController {
  query: FinanceSearchQuery;
  page?: FinanceSearchPage;
  records: FinanceSearchRecord[];
  loading: boolean;
  loadingMore: boolean;
  error?: string;
  selected?: FinanceSearchRecord;
  detail?: FinanceRecordDetail;
  detailLoading: boolean;
  detailError?: string;
  exporting: boolean;
  exportError?: string;
  search(query?: Partial<FinanceSearchQuery>): Promise<void>;
  loadMore(): Promise<void>;
  openDetail(record: FinanceSearchRecord): Promise<void>;
  retryDetail(): Promise<void>;
  closeDetail(): void;
  downloadCsv(): Promise<void>;
}

export function mergeFinanceRecords(current: readonly FinanceSearchRecord[], incoming: readonly FinanceSearchRecord[]) {
  const seen = new Set(current.map(record => `${record.kind}:${record.workspaceId}:${record.id}`));
  return [...current, ...incoming.filter(record => !seen.has(`${record.kind}:${record.workspaceId}:${record.id}`))];
}

export const financeErrorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

export class LatestFinanceRequest {
  private sequence = 0;
  private controller?: AbortController;

  begin() {
    this.controller?.abort();
    this.controller = new AbortController();
    return { id: ++this.sequence, signal: this.controller.signal };
  }

  isCurrent(id: number) {
    return id === this.sequence && !this.controller?.signal.aborted;
  }

  cancel() {
    this.sequence += 1;
    this.controller?.abort();
    this.controller = undefined;
  }
}

export function useFinanceSearch(client: FinanceSearchClient, initialQuery: FinanceSearchQuery = { limit: 50 }, autoLoad = false): FinanceSearchController {
  const initialQueryRef = useRef(initialQuery);
  const [query, setQuery] = useState<FinanceSearchQuery>(initialQuery);
  const [page, setPage] = useState<FinanceSearchPage>();
  const [records, setRecords] = useState<FinanceSearchRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<FinanceSearchRecord>();
  const [detail, setDetail] = useState<FinanceRecordDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string>();
  const searchRequests = useRef(new LatestFinanceRequest());
  const detailRequests = useRef(new LatestFinanceRequest());

  const runSearch = useCallback(async (next: FinanceSearchQuery, append: boolean) => {
    const request = searchRequests.current.begin();
    append ? setLoadingMore(true) : setLoading(true);
    setError(undefined);
    try {
      const loaded = await client.search(next, request.signal);
      if (!searchRequests.current.isCurrent(request.id)) return;
      setPage(loaded);
      setQuery({ ...next, snapshotAt: loaded.snapshotAt });
      setRecords(current => append ? mergeFinanceRecords(current, loaded.records) : loaded.records);
    } catch (cause) {
      if (!searchRequests.current.isCurrent(request.id)) return;
      setError(financeErrorMessage(cause, "财务记录加载失败，请重试。"));
    } finally {
      if (searchRequests.current.isCurrent(request.id)) { setLoading(false); setLoadingMore(false); }
    }
  }, [client]);

  const search = useCallback(async (changes: Partial<FinanceSearchQuery> = {}) => {
    const next = { ...query, ...changes, cursor: undefined, snapshotAt: undefined };
    await runSearch(next, false);
  }, [query, runSearch]);

  const loadMore = useCallback(async () => {
    if (!page?.nextCursor || loading || loadingMore) return;
    await runSearch({ ...query, cursor: page.nextCursor, snapshotAt: page.snapshotAt }, true);
  }, [loading, loadingMore, page, query, runSearch]);

  const openDetail = useCallback(async (record: FinanceSearchRecord) => {
    const request = detailRequests.current.begin();
    setSelected(record); setDetail(undefined); setDetailError(undefined); setDetailLoading(true);
    try {
      const loaded = await client.detail({ workspaceId: record.workspaceId, kind: record.kind, id: record.id, expectedVersion: record.version, snapshotAt: page?.snapshotAt ?? new Date().toISOString() }, request.signal);
      if (detailRequests.current.isCurrent(request.id)) setDetail(loaded);
    } catch (cause) {
      if (detailRequests.current.isCurrent(request.id)) setDetailError(financeErrorMessage(cause, "财务详情加载失败，请刷新搜索结果后重试。"));
    } finally {
      if (detailRequests.current.isCurrent(request.id)) setDetailLoading(false);
    }
  }, [client, page?.snapshotAt]);

  const closeDetail = useCallback(() => {
    detailRequests.current.cancel();
    setSelected(undefined); setDetail(undefined); setDetailError(undefined); setDetailLoading(false);
  }, []);

  const retryDetail = useCallback(async () => {
    if (selected) await openDetail(selected);
  }, [openDetail, selected]);

  const downloadCsv = useCallback(async () => {
    setExporting(true); setExportError(undefined);
    const controller = new AbortController();
    try {
      const exported = await client.exportCsv({ ...query, cursor: undefined, snapshotAt: page?.snapshotAt }, controller.signal);
      const url = URL.createObjectURL(new Blob([exported.csv], { type: exported.contentType }));
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = exported.fileName; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) {
      if (!controller.signal.aborted) setExportError(financeErrorMessage(cause, "财务导出失败，请重试。"));
    } finally { setExporting(false); }
  }, [client, page?.snapshotAt, query]);

  useEffect(() => () => { searchRequests.current.cancel(); detailRequests.current.cancel(); }, []);
  useEffect(() => { if (autoLoad) void runSearch(initialQueryRef.current, false); }, [autoLoad, runSearch]);

  return { query, page, records, loading, loadingMore, error, selected, detail, detailLoading, detailError, exporting, exportError, search, loadMore, openDetail, retryDetail, closeDetail, downloadCsv };
}
