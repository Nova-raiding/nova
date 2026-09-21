import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isCurrentSupportRequest } from "./useSupportDomain.js";

describe("support request tenant boundary", () => {
  it("rejects a response from the previous workspace even before effect cleanup runs", () => {
    expect(isCurrentSupportRequest(4, 4, "ws_previous", "ws_current")).toBe(false);
  });

  it("rejects an older response in the same workspace", () => {
    expect(isCurrentSupportRequest(3, 4, "ws_current", "ws_current")).toBe(false);
  });

  it("accepts only the latest response for the active workspace", () => {
    expect(isCurrentSupportRequest(4, 4, "ws_current", "ws_current")).toBe(true);
  });
});

/**
 * Guard for the SLA-correction decide approval transport.
 *
 * `opsDomainClients.decideCorrection` already accepted `options?: OpsRpcOptions`
 * (which becomes the `x-authorization-approval-token` header), but both this
 * hook's client interface and the model function were 2-arg, so that transport
 * argument was unreachable from any typed caller: the 批准/拒绝 controls had no
 * way to send the grant the server resolves the approver from. These assertions
 * read the real file contents, in the source-scanning style of
 * `RuleCenterSection.test.tsx`.
 */
describe("SLA correction decide approval transport", () => {
  const source = readFileSync(new URL("./useSupportDomain.ts", import.meta.url), "utf8");

  it("lets a typed caller reach the OpsRpcOptions transport argument", () => {
    expect(source).toContain("reason: string; idempotencyKey: string }, options?: OpsRpcOptions)");
    // Optional at this layer so existing callers keep compiling.
    expect(source).toContain('decideCorrection?: (decision: "approved" | "rejected", reason: string, approvalToken?: string) => Promise<void>');
  });

  it("forwards the token as a header option, never inside the rpc params", () => {
    const callIndex = source.indexOf("client.decideCorrection(");
    expect(callIndex).toBeGreaterThan(-1);
    const optionsIndex = source.indexOf("}, { authorizationApprovalToken: approvalToken?.trim() })", callIndex);
    expect(optionsIndex, "the decide call must pass the token via OpsRpcOptions").toBeGreaterThan(callIndex);
    if (optionsIndex < 0) return;
    // The slice is exactly the params literal the transport serialises into the
    // JSON-RPC body; the bearer token must not appear there, or the console
    // would be back to shipping a caller-asserted approver on the wire.
    const paramsLiteral = source.slice(callIndex, optionsIndex);
    expect(paramsLiteral).not.toContain("approvalToken");
    expect(paramsLiteral).toContain("correctionId: correction.correctionId");
  });
});
