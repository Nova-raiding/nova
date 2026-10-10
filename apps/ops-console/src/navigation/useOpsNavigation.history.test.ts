import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPS_NAVIGATION_INDEX_KEY,
  pushOpsNavigationEntry,
  replaceOpsNavigationEntry,
} from "./useOpsNavigation.js";

interface HistoryEntry {
  state: unknown;
  url: string;
}

function installHistory(initialState: unknown = null, initialUrl = "/ops/overview") {
  const entries: HistoryEntry[] = [{ state: initialState, url: initialUrl }];
  let current = 0;
  const history = {
    get state() {
      return entries[current]?.state ?? null;
    },
    pushState(state: unknown, _title: string, url: string) {
      entries.splice(current + 1);
      entries.push({ state, url });
      current += 1;
    },
    replaceState(state: unknown, _title: string, url: string) {
      entries[current] = { state, url };
    },
  };
  vi.stubGlobal("window", { history });
  return {
    entries,
    get current() { return entries[current]; },
    get length() { return entries.length; },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Ops navigation history entries", () => {
  it("pushes a route with the next index and preserves unrelated history state", () => {
    const memory = installHistory({ routerKey: "kept", [OPS_NAVIGATION_INDEX_KEY]: 6 }, "/ops/overview?workspaceId=ws-1");

    pushOpsNavigationEntry("/ops/finance?workspaceId=ws-1&accountId=acct-2");

    expect(memory.length).toBe(2);
    expect(memory.current).toEqual({
      url: "/ops/finance?workspaceId=ws-1&accountId=acct-2",
      state: { routerKey: "kept", [OPS_NAVIGATION_INDEX_KEY]: 7 },
    });
  });

  it("replaces a redirected route without adding a Back entry or changing its index", () => {
    const memory = installHistory({ routerKey: "kept", [OPS_NAVIGATION_INDEX_KEY]: 7 }, "/ops/members?workbench=workspace");

    replaceOpsNavigationEntry("/ops/overview?workbench=platform");

    expect(memory.length).toBe(1);
    expect(memory.current).toEqual({
      url: "/ops/overview?workbench=platform",
      state: { routerKey: "kept", [OPS_NAVIGATION_INDEX_KEY]: 7 },
    });
  });

  it("starts at index zero and assigns index one to the first pushed route", () => {
    const memory = installHistory({ routerKey: "kept" });

    pushOpsNavigationEntry("/ops/users");

    expect(memory.current?.state).toEqual({ routerKey: "kept", [OPS_NAVIGATION_INDEX_KEY]: 1 });
  });
});
