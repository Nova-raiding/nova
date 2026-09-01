import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";

type UnsavedChangesContextValue = {
  labels: readonly string[];
  setDirty(id: string, dirty: boolean, label: string): void;
};

const UnsavedChangesContext = createContext<UnsavedChangesContextValue>({ labels: [], setDirty: () => undefined });

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<ReadonlyMap<string, string>>(() => new Map());
  const setDirty = useCallback((id: string, dirty: boolean, label: string) => {
    setEntries((current) => {
      const next = new Map(current);
      if (dirty) next.set(id, label);
      else next.delete(id);
      return next;
    });
  }, []);
  const value = useMemo<UnsavedChangesContextValue>(() => ({
    labels: [...new Set(entries.values())],
    setDirty,
  }), [entries, setDirty]);
  return <UnsavedChangesContext.Provider value={value}>{children}</UnsavedChangesContext.Provider>;
}

export function useUnsavedChangesState() {
  return useContext(UnsavedChangesContext);
}

export function useUnsavedChanges(dirty: boolean, label: string) {
  const id = useId();
  const { setDirty } = useUnsavedChangesState();
  useEffect(() => {
    setDirty(id, dirty, label);
    return () => setDirty(id, false, label);
  }, [dirty, id, label, setDirty]);
}
