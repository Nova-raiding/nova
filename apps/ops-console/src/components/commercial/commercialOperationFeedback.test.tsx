import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { dangerActionFocusPlan } from "../authz/DangerActionModal.js";
import {
  CommercialOperationOutcomeAlert,
  commercialOperationDecision,
  commercialOperationOutcome,
  idleCommercialOperationOutcome,
  irreversibleCommercialOperations,
  settleCommercialOperation,
  type CommercialOperationId,
} from "./commercialOperationFeedback.js";

const workspaceSource = readFileSync(new URL("./CommercialOperationsWorkspace.tsx", import.meta.url), "utf8");
const dangerModalSource = readFileSync(new URL("../authz/DangerActionModal.tsx", import.meta.url), "utf8");

/** The ten commands that only prepare, propose or approve something in a server-owned two-person flow. */
const reversibleOperations: CommercialOperationId[] = [
  "createPrivateTrialInvite",
  "createPrivateTrialEligibility",
  "approvePrivateTrialEligibility",
  "createPrivateTrialOrder",
  "completePrivateTrialValidation",
  "preparePrivateTrialCredit",
  "approvePrivateTrialCredit",
  "createPrivateTrialConversionOrder",
  "requestCommercialRefund",
  "approveCommercialRefund",
];

describe("commercial operation outcome", () => {
  it("separates an accepted command from a rejected one instead of writing both into one message", () => {
    expect(commercialOperationOutcome({ settled: "fulfilled", value: { request_id: "req_1" } }))
      .toEqual({ status: "success", text: '{"request_id":"req_1"}' });
    expect(commercialOperationOutcome({ settled: "rejected", error: new Error("403 FORBIDDEN") }))
      .toEqual({ status: "error", text: "403 FORBIDDEN" });
    expect(commercialOperationOutcome({ settled: "rejected", error: "REVISION_CONFLICT" }))
      .toEqual({ status: "error", text: "REVISION_CONFLICT" });
    expect(idleCommercialOperationOutcome.status).toBe("idle");
  });

  it("never lets a rejected command reach the success state", async () => {
    const rejected = await settleCommercialOperation(async () => { throw new Error("COMMERCIAL_REVISION_CONFLICT"); });
    expect(rejected.status).toBe("error");
    expect(rejected).toMatchObject({ text: "COMMERCIAL_REVISION_CONFLICT" });

    const accepted = await settleCommercialOperation(async () => ({ state: "RECOVERED" }));
    expect(accepted.status).toBe("success");
    expect(accepted).toMatchObject({ text: '{"state":"RECOVERED"}' });
  });

  it("renders a failure as a role=alert error, not as the neutral copyable paragraph", () => {
    const html = renderToStaticMarkup(
      <CommercialOperationOutcomeAlert
        outcome={commercialOperationOutcome({ settled: "rejected", error: new Error("403 FORBIDDEN：缺少 commercial.payment.reconcile") })}
      />,
    );
    expect(html).toContain('<div role="alert" aria-live="assertive" aria-atomic="true" data-commercial-outcome="error">');
    expect(html).toContain("ant-alert-error");
    expect(html).toContain("403 FORBIDDEN");
    // The pre-fix surface was one code paragraph with a copy button for both outcomes.
    expect(html).not.toContain("ant-alert-success");
    expect(html).not.toContain("ant-typography-copy");
  });

  it("renders an accepted command differently enough that the two cannot be confused", () => {
    const success = renderToStaticMarkup(
      <CommercialOperationOutcomeAlert outcome={commercialOperationOutcome({ settled: "fulfilled", value: { request_id: "req_ok" } })} />,
    );
    const failure = renderToStaticMarkup(
      <CommercialOperationOutcomeAlert outcome={commercialOperationOutcome({ settled: "rejected", error: new Error("403 FORBIDDEN") })} />,
    );
    expect(success).toContain('data-commercial-outcome="success"');
    expect(success).toContain("ant-alert-success");
    expect(success).toContain("req_ok");
    expect(success).toContain("ant-typography-copy");
    // Only the failure surface is an assertive alert; antd stamps role=alert on
    // every Alert, so the live region is what separates "read at once" from "read later".
    expect(success).not.toContain('aria-live="assertive"');
    expect(failure).not.toContain('data-commercial-outcome="success"');
    expect(failure).toContain("ant-alert-error");
  });

  it("renders nothing while no command has run", () => {
    expect(renderToStaticMarkup(<CommercialOperationOutcomeAlert outcome={idleCommercialOperationOutcome} />)).toBe("");
  });
});

describe("commercial operation confirmation gate", () => {
  it("requires a confirmation for exactly the four irreversible money and point commands", () => {
    expect([...irreversibleCommercialOperations]).toEqual([
      "verifyCommercialOrderTransfer",
      "verifyPrivateTrialPayment",
      "verifyPrivateTrialTransfer",
      "completeCommercialRefund",
    ]);
    for (const id of reversibleOperations) {
      expect(commercialOperationDecision(id, false)).toEqual({ requiresConfirmation: false, execute: true });
    }
    for (const id of irreversibleCommercialOperations) {
      expect(commercialOperationDecision(id, false)).toEqual({ requiresConfirmation: true, execute: false });
      expect(commercialOperationDecision(id, true)).toEqual({ requiresConfirmation: true, execute: true });
    }
  });

  it("does not invoke the command when the operator has not confirmed it", async () => {
    const calls: string[] = [];
    // Mirrors the guard both panels use before calling the server.
    const run = async (id: CommercialOperationId, action: () => Promise<unknown>) => {
      if (!commercialOperationDecision(id, false).execute) return;
      await action();
    };
    for (const id of irreversibleCommercialOperations) await run(id, async () => { calls.push(`executed:${id}`); return id; });
    expect(calls).toEqual([]);
    expect(commercialOperationDecision("completeCommercialRefund", true).execute).toBe(true);
    await run("requestCommercialRefund", async () => { calls.push("executed:requestCommercialRefund"); return "requestCommercialRefund"; });
    expect(calls).toEqual(["executed:requestCommercialRefund"]);
  });

  it("covers every command the two panels can send", () => {
    const usedIds = [...workspaceSource.matchAll(/run\("([^"]+)"/gu)].map((match) => match[1]);
    const confirmedIds = [...workspaceSource.matchAll(/\bid: "([^"]+)"/gu)].map((match) => match[1]);
    expect(new Set([...usedIds, ...confirmedIds])).toEqual(
      new Set([...irreversibleCommercialOperations, ...reversibleOperations]),
    );
    expect(usedIds).toHaveLength(10);
    expect(confirmedIds).toHaveLength(4);
  });

  it("routes the four irreversible commands through the confirmation dialog only", () => {
    expect(workspaceSource).toContain("commercialOperationDecision(id, false).execute");
    expect(workspaceSource).toContain("commercialOperationDecision(pending.id, true).execute");
    for (const id of irreversibleCommercialOperations) {
      expect(workspaceSource).toContain(`id: "${id}"`);
      expect(workspaceSource).not.toContain(`void run("${id}"`);
    }
  });

  it("shows the affected object, scope and impact in every confirmation dialog", () => {
    for (const id of irreversibleCommercialOperations) {
      const start = workspaceSource.indexOf(`id: "${id}"`);
      expect(start).toBeGreaterThan(-1);
      const block = workspaceSource.slice(start, start + 900);
      expect(block).toContain("objectLabel:");
      expect(block).toContain("objectValue:");
      expect(block).toContain("scope:");
      expect(block).toContain("impact:");
      expect(block).toContain("defaultReason:");
    }
    // The refund dialog has to name the order, the amount and the rolled-back points.
    expect(workspaceSource).toContain("退款请求 ID");
    expect(workspaceSource).toContain("外部凭证");
    expect(workspaceSource).toContain("创意点");
  });

  it("keeps both panels free of the shared neutral message paragraph", () => {
    expect(workspaceSource).not.toContain("<Typography.Paragraph copyable={{ text: message }} code>");
    expect(workspaceSource.match(/<CommercialOperationOutcomeAlert outcome=\{outcome\} \/>/gu)).toHaveLength(2);
  });
});

describe("confirmation dialog default focus", () => {
  it("focuses cancel so a stray Enter aborts an irreversible command", () => {
    expect(dangerActionFocusPlan("cancel")).toEqual({ reason: false, cancel: true });
    expect(dangerActionFocusPlan()).toEqual({ reason: true, cancel: false });
  });

  it("binds the focus plan and keeps the confirm button blocked until a reason is present", () => {
    expect(dangerModalSource).toContain("autoFocus={focusPlan.reason}");
    expect(dangerModalSource).toContain("autoFocus={focusPlan.cancel}");
    expect(dangerModalSource).toContain("disabled={!reason.trim() || loading}");
    // Both commercial dialogs opt into cancel-first.
    expect(workspaceSource.match(/initialFocus="cancel"/gu)).toHaveLength(2);
  });

  it("runs the command from the dialog confirmation, not from opening it", () => {
    expect(workspaceSource.match(/onConfirm=\{confirmPending\}/gu)).toHaveLength(2);
    expect(workspaceSource.match(/const requestConfirmation = \(next: PendingCommercialOperation, trigger: HTMLElement \| null\)/gu)).toHaveLength(2);
    // One call site per irreversible command; nothing opens the dialog implicitly.
    expect(workspaceSource.match(/requestConfirmation\(\{/gu)).toHaveLength(4);
  });
});
