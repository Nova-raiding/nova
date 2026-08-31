import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FeatureFlag,
  FeatureFlagEmergencyRequest,
  FeatureFlagEvent,
  FeatureFlagListRequest,
  FeatureFlagMutationRequest,
  FeatureFlagPage,
} from "../../../../packages/contracts/src/ops/feature-flags.js";

export interface FeatureFlagsClient {
  list(input: FeatureFlagListRequest): Promise<FeatureFlagPage>;
  save(input: FeatureFlagMutationRequest): Promise<{ flag: FeatureFlag; replayed: boolean }>;
  setEmergency(input: FeatureFlagEmergencyRequest): Promise<{ flag: FeatureFlag; replayed: boolean }>;
  events(flagId: string): Promise<FeatureFlagEvent[]>;
}

export interface FeatureFlagFilters { environment?: string; query?: string }

export function featureFlagListRequest(filters: FeatureFlagFilters, cursor?: string): FeatureFlagListRequest {
  return { ...filters, ...(cursor ? { cursor } : {}), limit: 50 };
}

export class FeatureFlagsRequestGate {
  private sequence = 0;
  begin() { return ++this.sequence; }
  isCurrent(request: number) { return request === this.sequence; }
  invalidate() { this.sequence += 1; }
}

export function useFeatureFlags(client: FeatureFlagsClient, initialFilters: FeatureFlagFilters = {}) {
  const [items, setItems] = useState<FeatureFlag[]>([]);
  const [filters, setFilters] = useState(initialFilters);
  const [nextCursor, setNextCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const requests = useRef(new FeatureFlagsRequestGate());

  const load = useCallback(async (cursor?: string) => {
    const request = requests.current.begin();
    cursor ? setLoadingMore(true) : setLoading(true);
    setError(undefined);
    try {
      const page = await client.list(featureFlagListRequest(filters, cursor));
      if (!requests.current.isCurrent(request)) return;
      setItems(previous => cursor ? [...previous, ...page.items.filter(item => !previous.some(row => row.id === item.id))] : page.items);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (requests.current.isCurrent(request)) setError(cause instanceof Error ? cause.message : "功能开关加载失败");
    } finally {
      if (requests.current.isCurrent(request)) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [client, filters]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => requests.current.invalidate(), []);

  const save = useCallback(async (input: FeatureFlagMutationRequest) => {
    setSaving(true);
    setError(undefined);
    try {
      const result = await client.save(input);
      setItems(previous => [result.flag, ...previous.filter(item => item.id !== result.flag.id)]);
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "功能开关保存失败");
      throw cause;
    } finally { setSaving(false); }
  }, [client]);

  const setEmergency = useCallback(async (input: FeatureFlagEmergencyRequest) => {
    setSaving(true);
    setError(undefined);
    try {
      const result = await client.setEmergency(input);
      setItems(previous => previous.map(item => item.id === result.flag.id ? result.flag : item));
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "紧急开关操作失败");
      throw cause;
    } finally { setSaving(false); }
  }, [client]);

  const loadEvents = useCallback((flagId: string) => client.events(flagId), [client]);
  return { items, filters, setFilters, nextCursor, loading, loadingMore, saving, error, load, save, setEmergency, loadEvents };
}
