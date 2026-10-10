import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";

type UnsavedChangesContextValue = {
  labels: readonly string[];
  clearAll(): void;
  setDirty(id: string, dirty: boolean, label: string): void;
  requestTransition(transition: UnsavedTransition): boolean;
  pendingTransition?: PendingUnsavedTransition;
  cancelTransition(): void;
  confirmTransition(): void;
};

export type UnsavedTransition = { commit(): void; cancel?(): void };
export type PendingUnsavedTransition = UnsavedTransition & { labels: readonly string[] };

const UnsavedChangesContext = createContext<UnsavedChangesContextValue>({ labels: [], clearAll: () => undefined, setDirty: () => undefined, requestTransition: () => false, cancelTransition: () => undefined, confirmTransition: () => undefined });

export function updateUnsavedChangeEntries(
  current: ReadonlyMap<string, string>,
  id: string,
  dirty: boolean,
  label: string,
): ReadonlyMap<string, string> {
  const next = new Map(current);
  if (dirty) next.set(id, label);
  else next.delete(id);
  return next;
}

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [pendingTransition, setPendingTransition] = useState<PendingUnsavedTransition>();
  const setDirty = useCallback((id: string, dirty: boolean, label: string) => {
    setEntries((current) => updateUnsavedChangeEntries(current, id, dirty, label));
  }, []);
  const labels = [...new Set(entries.values())];
  const requestTransition = useCallback((transition: UnsavedTransition) => {
    if (labels.length === 0) return false;
    setPendingTransition({ ...transition, labels });
    return true;
  }, [labels]);
  const cancelTransition = useCallback(() => {
    const pending = pendingTransition;
    setPendingTransition(undefined);
    pending?.cancel?.();
  }, [pendingTransition]);
  const confirmTransition = useCallback(() => {
    const pending = pendingTransition;
    if (!pending) return;
    setPendingTransition(undefined);
    setEntries(new Map());
    pending.commit();
  }, [pendingTransition]);
  const value = useMemo<UnsavedChangesContextValue>(() => ({
    labels,
    clearAll: () => setEntries(new Map()),
    setDirty,
    requestTransition,
    pendingTransition,
    cancelTransition,
    confirmTransition,
  }), [labels, setDirty, requestTransition, pendingTransition, cancelTransition, confirmTransition]);
  return <UnsavedChangesContext.Provider value={value}>{children}</UnsavedChangesContext.Provider>;
}

export function useUnsavedChangesState() {
  return useContext(UnsavedChangesContext);
}

export function useUnsavedChanges(dirty: boolean, label: string) {
  const { setDirty } = useUnsavedChangesState();
  const id = useId();
  useEffect(() => {
    setDirty(id, dirty, label);
    return () => setDirty(id, false, label);
  }, [dirty, id, label, setDirty]);
}
