import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

type UnsavedChangesContextValue = {
  labels: readonly string[];
  clearAll(): void;
  setDirty(id: string, dirty: boolean, label: string): void;
};

const UnsavedChangesContext = createContext<UnsavedChangesContextValue>({ labels: [], clearAll: () => undefined, setDirty: () => undefined });

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
    clearAll: () => setEntries(new Map()),
    setDirty,
  }), [entries, setDirty]);
  return <UnsavedChangesContext.Provider value={value}>{children}</UnsavedChangesContext.Provider>;
}

export function useUnsavedChangesState() {
  return useContext(UnsavedChangesContext);
}

export function useUnsavedChanges(dirty: boolean, label: string) {
  const { setDirty } = useUnsavedChangesState();
  useEffect(() => {
    setDirty(label, dirty, label);
  }, [dirty, label, setDirty]);
}
