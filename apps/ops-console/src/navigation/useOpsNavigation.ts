import { useEffect, useRef, useState } from "react";
import {
  domainFromLocation,
  type OpsDomain,
  urlForDomain,
  urlForDomainWithQuery,
} from "./opsNavigation.js";

function canonicalizeOpsLocation(location: Pick<Location, "pathname" | "search" | "hash">): OpsDomain {
  const domain = domainFromLocation(location);
  const canonical = urlForDomain(location, domain);
  const next = `${canonical}${location.hash}`;
  const current = `${location.pathname}${location.search}${location.hash}`;
  if (current !== next) window.history.replaceState(window.history.state, "", next);
  return domain;
}

export const OPS_NAVIGATION_INDEX_KEY = "__opsNavigationIndex";

function readHistoryIndex(): number | undefined {
  const state: unknown = window.history.state;
  if (!state || typeof state !== "object") return undefined;
  const index = (state as Record<string, unknown>)[OPS_NAVIGATION_INDEX_KEY];
  return typeof index === "number" && Number.isInteger(index) ? index : undefined;
}

function writeHistoryIndex(index: number, mode: "push" | "replace", url: string) {
  const currentState: unknown = window.history.state;
  const state = currentState && typeof currentState === "object" ? { ...currentState } : {};
  (state as Record<string, unknown>)[OPS_NAVIGATION_INDEX_KEY] = index;
  if (mode === "push") window.history.pushState(state, "", url);
  else window.history.replaceState(state, "", url);
}

export function pushOpsNavigationEntry(url: string) {
  writeHistoryIndex((readHistoryIndex() ?? 0) + 1, "push", url);
}

export function replaceOpsNavigationEntry(url: string) {
  writeHistoryIndex(readHistoryIndex() ?? 0, "replace", url);
}

function focusOpsMainContent() {
  window.requestAnimationFrame(() =>
    document.querySelector<HTMLElement>("#ops-main-content")?.focus({ preventScroll: true }),
  );
}

export function useOpsNavigation(options: {
  onPopstate?: (domain: OpsDomain, commit: () => void) => boolean;
  beforeNavigate?: (transition: { commit(): void; cancel?(): void }) => boolean;
} = {}): {
  activeDomain: OpsDomain;
  navigate: (domain: OpsDomain) => void;
  navigateWithQuery: (domain: OpsDomain, query: Record<string, string | undefined>) => void;
} {
  const [activeDomain, setActiveDomain] = useState<OpsDomain>(() =>
    canonicalizeOpsLocation(window.location),
  );
  const currentEntry = useRef<{ index: number; url: string } | undefined>(undefined);
  if (currentEntry.current === undefined) {
    const index = readHistoryIndex() ?? 0;
    if (readHistoryIndex() === undefined) writeHistoryIndex(index, "replace", `${window.location.pathname}${window.location.search}${window.location.hash}`);
    currentEntry.current = { index, url: `${window.location.pathname}${window.location.search}${window.location.hash}` };
  }

  useEffect(() => {
    const restore = () => {
      const domain = canonicalizeOpsLocation(window.location);
      const targetUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      const previous = currentEntry.current ?? { index: 0, url: targetUrl };
      const targetIndex = readHistoryIndex() ?? previous.index - 1;
      const commit = () => {
        currentEntry.current = { index: targetIndex, url: targetUrl };
        setActiveDomain(domain);
        focusOpsMainContent();
      };
      const apply = () => {
        if (!options.onPopstate?.(domain, commit)) commit();
      };
      const cancel = () => {
        const delta = previous.index - targetIndex;
        if (delta !== 0) window.history.go(delta);
      };
      // A cancelled popstate is restored with history.go(). Accept that return
      // to the last committed entry without reopening the same prompt.
      if (targetUrl !== previous.url && options.beforeNavigate?.({ commit: apply, cancel })) return;
      apply();
    };
    window.addEventListener("hashchange", restore);
    window.addEventListener("popstate", restore);
    return () => {
      window.removeEventListener("hashchange", restore);
      window.removeEventListener("popstate", restore);
    };
  }, [options.onPopstate, options.beforeNavigate]);

  const navigate = (domain: OpsDomain) => {
    const target = urlForDomain(window.location, domain);
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (currentUrl === target) return;
    const commit = () => {
      const nextIndex = (readHistoryIndex() ?? currentEntry.current?.index ?? 0) + 1;
      writeHistoryIndex(nextIndex, "push", target);
      currentEntry.current = { index: nextIndex, url: target };
      setActiveDomain(domain);
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
      focusOpsMainContent();
    };
    if (options.beforeNavigate?.({ commit })) return;
    commit();
  };

  const navigateWithQuery = (domain: OpsDomain, query: Record<string, string | undefined>) => {
    const target = urlForDomainWithQuery(window.location, domain, query);
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const commit = () => {
      if (currentUrl !== target) {
        const nextIndex = (readHistoryIndex() ?? currentEntry.current?.index ?? 0) + 1;
        writeHistoryIndex(nextIndex, "push", target);
        currentEntry.current = { index: nextIndex, url: target };
      }
      setActiveDomain(domain);
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
      focusOpsMainContent();
    };
    if (currentUrl === target) return;
    if (options.beforeNavigate?.({ commit })) return;
    commit();
  };

  return { activeDomain, navigate, navigateWithQuery };
}
