import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  rpc,
  rpcForWorkspace,
  rpcForWorkspaceWithMeta,
  rpcWithMeta,
  type OpsRpcOptions,
} from "../apps/ops-console/src/api/opsClient.js";

/**
 * Behaviour guard for the console's maker-checker approval-header transport.
 *
 * The API resolves the `approval` obligation's approver ONLY from a
 * server-issued token carried in a request header (`verifiedApprovalActor` for
 * `x-authorization-approval-token`, the rule-activation gate for
 * `x-rule-approval-token` in apps/api/src/server.ts). `rpcAtWorkspace` is the
 * only place those two headers are assembled.
 *
 * An earlier version of this file scanned the SOURCE of `opsClient.ts` for the
 * assignment lines. That only proved the header was written in one particular
 * spelling, and it stayed green while the grant was corrupted or never sent:
 * writing `X-Authorization-Approval-Token` (case variant) does not fail a
 * `headers["x-authorization-approval-token"] === token` check, and fetch then
 * MERGES the case-variant pair into a single comma-joined value
 * ("REAL, AMBIENT"), so the server receives a garbage token and the console's
 * approval silently fails. A spread at the `fetch` call site overwriting the
 * header after assembly was invisible for the same reason. So these tests stub
 * `globalThis.fetch` and assert on the `RequestInit.headers` the transport
 * ACTUALLY built, reusing the fetch-stubbing and connection-setup idiom of
 * `apps/ops-console/src/api/opsClient.test.ts`.
 *
 * `rpcAtWorkspace` is module-private, so the narrowest exported entries that
 * reach it are `rpcWithMeta` and `rpcForWorkspaceWithMeta`. The public `rpc` /
 * `rpcForWorkspace` wrappers are exercised too, so the option travels end to
 * end from the caller through the whole wrapper chain to the wire.
 */

const clientSource = readFileSync(
  new URL("../apps/ops-console/src/api/opsClient.ts", import.meta.url),
  "utf8",
);

type ApprovalOption = "authorizationApprovalToken" | "ruleApprovalToken";

const AUTHORIZATION_GRANT = {
  header: "x-authorization-approval-token",
  option: "authorizationApprovalToken" as ApprovalOption,
  token: "grant-authorization-1",
};
const RULE_GRANT = {
  header: "x-rule-approval-token",
  option: "ruleApprovalToken" as ApprovalOption,
  token: "grant-rule-1",
};
const BOTH_GRANTS = [AUTHORIZATION_GRANT, RULE_GRANT] as const;

/** Sentinel stored under every ambient key a fallback might read. */
const AMBIENT_GRANT_SENTINEL = "AMBIENT-GRANT-MUST-NOT-BE-SENT";
const AMBIENT_GRANT_KEYS: Record<string, string> = {
  ops_approval_token: AMBIENT_GRANT_SENTINEL,
  authorization_approval_token: AMBIENT_GRANT_SENTINEL,
  ops_authorization_approval_token: AMBIENT_GRANT_SENTINEL,
  ops_rule_approval_token: AMBIENT_GRANT_SENTINEL,
  rule_approval_token: AMBIENT_GRANT_SENTINEL,
  ops_access_grant: AMBIENT_GRANT_SENTINEL,
};

const CONNECTION_CONFIG = {
  apiBase: "http://ops.test",
  workspaceId: "ws-authorized",
  actorId: "actor-ops",
  token: "token-ops",
  workbench: "workspace",
};

function optionsWith(
  grants: ReadonlyArray<{ option: ApprovalOption; token: string }>,
): OpsRpcOptions {
  const options: OpsRpcOptions = {};
  for (const grant of grants) options[grant.option] = grant.token;
  return options;
}

/** Map-backed Storage: writes are visible to later reads within one test. */
function mapBackedStorage(entries: Record<string, string>) {
  const values = new Map<string, string>(Object.entries(entries));
  return {
    storage: {
      getItem: (key: string) => values.get(key) ?? "",
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
      clear: () => {
        values.clear();
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    },
  };
}

/**
 * Install a connected ops console and a fetch stub, mirroring the harness of
 * opsClient.test.ts. Both stores carry the connection tuple (so the request has
 * an apiBase regardless of which store the module selects) and the ambient
 * sentinel, so "the header is absent" is a real assertion rather than an
 * accident of an empty store.
 */
function stubTransport() {
  const local = mapBackedStorage({
    ops_connection_config_v1: JSON.stringify(CONNECTION_CONFIG),
    ...AMBIENT_GRANT_KEYS,
  });
  vi.stubGlobal("localStorage", local.storage);
  vi.stubGlobal("sessionStorage", local.storage);
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ data: { jsonrpc: "2.0", id: "1", result: {} } }),
        { status: 200 },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The header object the transport handed to `fetch` on the given call. */
function sentHeaders(
  fetchMock: ReturnType<typeof stubTransport>,
  callIndex = 0,
): Record<string, string> {
  const calls = fetchMock.mock.calls as unknown as Array<
    [RequestInfo | URL, RequestInit?]
  >;
  expect(
    calls.length,
    `fetch must have been called at least ${callIndex + 1} time(s)`,
  ).toBeGreaterThan(callIndex);
  return (calls[callIndex]?.[1]?.headers ?? {}) as Record<string, string>;
}

/**
 * Every key/value pair the transport emitted under `name`, matched
 * case-insensitively.
 *
 * Matching case-insensitively IS the assertion: a case-variant write still
 * satisfies `headers[name] === token`, but it adds a SECOND key, and fetch
 * joins the two into one corrupted value on the wire. So the expectation is on
 * the whole case-folded group: exactly one entry, spelled in the canonical
 * lowercase form, holding exactly the expected value. That single expectation
 * rejects a misspelled key, a case-variant key, a duplicate write, an ambient
 * fallback and a wrong value at once.
 */
function emittedHeader(
  headers: Record<string, string>,
  name: string,
): Array<[string, string]> {
  return Object.keys(headers)
    .filter((key) => key.toLowerCase() === name)
    .map((key) => [key, headers[key] ?? ""] as [string, string]);
}

const wrapperCalls: ReadonlyArray<{
  name: string;
  call: (options: OpsRpcOptions) => Promise<unknown>;
}> = [
  { name: "rpcWithMeta", call: (options) => rpcWithMeta("ops.test", {}, options) },
  {
    name: "rpcForWorkspaceWithMeta",
    call: (options) => rpcForWorkspaceWithMeta("ws-authorized", "ops.test", {}, options),
  },
  { name: "rpc", call: (options) => rpc("ops.test", {}, options) },
  {
    name: "rpcForWorkspace",
    call: (options) => rpcForWorkspace("ws-authorized", "ops.test", {}, options),
  },
];

describe("console approval-header transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends each grant under its exact canonical header name", async () => {
    const fetchMock = stubTransport();

    await rpcWithMeta("ops.test", {}, optionsWith(BOTH_GRANTS));

    const headers = sentHeaders(fetchMock);
    expect(
      emittedHeader(headers, AUTHORIZATION_GRANT.header),
      `authorizationApprovalToken must be sent as exactly one lowercase ${AUTHORIZATION_GRANT.header} header`,
    ).toEqual([[AUTHORIZATION_GRANT.header, AUTHORIZATION_GRANT.token]]);
    expect(
      emittedHeader(headers, RULE_GRANT.header),
      `ruleApprovalToken must be sent as exactly one lowercase ${RULE_GRANT.header} header`,
    ).toEqual([[RULE_GRANT.header, RULE_GRANT.token]]);
  });

  it("omits both grant headers when the caller supplies no options", async () => {
    const fetchMock = stubTransport();

    await rpcWithMeta("ops.test");

    const headers = sentHeaders(fetchMock);
    for (const grant of BOTH_GRANTS) {
      expect(
        emittedHeader(headers, grant.header),
        `no grant was supplied, so ${grant.header} must not be sent`,
      ).toEqual([]);
    }
    // A fallback could also ship the grant under a differently named header;
    // the seeded sentinel must not appear anywhere in the request at all.
    expect(
      Object.values(headers),
      "no header may carry a value taken from ambient state",
    ).not.toContain(AMBIENT_GRANT_SENTINEL);
  });

  it("drops a whitespace-only grant instead of sending a blank header", async () => {
    const fetchMock = stubTransport();

    await rpcWithMeta(
      "ops.test",
      {},
      optionsWith([
        { option: "authorizationApprovalToken", token: "   " },
        { option: "ruleApprovalToken", token: "\t\n " },
      ]),
    );

    const headers = sentHeaders(fetchMock);
    for (const grant of BOTH_GRANTS) {
      expect(
        emittedHeader(headers, grant.header),
        "a whitespace-only grant must not produce a header",
      ).toEqual([]);
    }
  });

  it("carries both grants through every exported rpc wrapper", async () => {
    for (const entry of wrapperCalls) {
      const fetchMock = stubTransport();

      await entry.call(optionsWith(BOTH_GRANTS));

      const headers = sentHeaders(fetchMock);
      expect(
        emittedHeader(headers, AUTHORIZATION_GRANT.header),
        `${entry.name} must forward authorizationApprovalToken to the request`,
      ).toEqual([[AUTHORIZATION_GRANT.header, AUTHORIZATION_GRANT.token]]);
      expect(
        emittedHeader(headers, RULE_GRANT.header),
        `${entry.name} must forward ruleApprovalToken to the request`,
      ).toEqual([[RULE_GRANT.header, RULE_GRANT.token]]);
    }
  });

  it("never resolves a grant from ambient browser state", () => {
    // WHY THIS IS SOURCE-LEVEL: the behaviour tests above prove the header is
    // absent for the ambient keys THEY seed (and for the two stores they stub).
    // A fallback to a key they do not name, or to `import.meta.env` -- which a
    // non-Vite test file cannot re-stub per test -- would still pass, because
    // the assertion can only enumerate what it knows about. The invariant is
    // stronger than any enumeration: no line of the client that touches a store
    // or the Vite env may mention the approval grants at all, so there is no
    // ambient expression that could even name one. Comment lines are skipped so
    // a documentation edit cannot fail this.
    const ambientGrantLines = clientSource
      .split("\n")
      .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/u.test(line))
      .filter((line) =>
        /localStorage|sessionStorage|import\.meta\.env/u.test(line),
      )
      .filter((line) => /approval|grant/iu.test(line));
    expect(
      ambientGrantLines,
      "an approval grant must never be read from localStorage, sessionStorage or import.meta.env",
    ).toEqual([]);
  });
});
