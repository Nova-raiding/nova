import { Alert, Space, Typography } from "antd";

/**
 * Operator feedback for a single commercial command.
 *
 * Success and failure are separate states on purpose: a rejected command must
 * never be rendered in the same neutral surface as an accepted one, otherwise
 * an operator who mistyped an id reads a 403 as "done" and stops retrying.
 */
export type CommercialOperationOutcome =
  | { readonly status: "idle" }
  | { readonly status: "success"; readonly text: string }
  | { readonly status: "error"; readonly text: string };

export const idleCommercialOperationOutcome: CommercialOperationOutcome = { status: "idle" };

/** A settled command, expressed without leaking the promise/catch shape into the UI. */
export type CommercialOperationSettlement =
  | { readonly settled: "fulfilled"; readonly value: unknown }
  | { readonly settled: "rejected"; readonly error: unknown };

export function commercialOperationSuccessText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "";
}

export function commercialOperationFailureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The single decision point that separates an accepted command from a rejected one. */
export function commercialOperationOutcome(settlement: CommercialOperationSettlement): CommercialOperationOutcome {
  if (settlement.settled === "fulfilled") return { status: "success", text: commercialOperationSuccessText(settlement.value) };
  return { status: "error", text: commercialOperationFailureText(settlement.error) };
}

/** Runs a command without ever throwing, so the caller cannot route a failure into the success state. */
export async function settleCommercialOperation(action: () => Promise<unknown>): Promise<CommercialOperationOutcome> {
  try { return commercialOperationOutcome({ settled: "fulfilled", value: await action() }); }
  catch (error) { return commercialOperationOutcome({ settled: "rejected", error }); }
}

/**
 * Renders the outcome of a commercial command. Failures are announced as an
 * assertive alert; acceptances are a distinct success alert with the raw server
 * payload kept copyable for the audit trail.
 */
export function CommercialOperationOutcomeAlert({ outcome }: { outcome: CommercialOperationOutcome }) {
  if (outcome.status === "idle") return null;
  if (outcome.status === "error") return <div role="alert" aria-live="assertive" aria-atomic="true" data-commercial-outcome="error">
    <Alert
      type="error"
      showIcon
      title="服务端未接受这次操作"
      description={<Space orientation="vertical" size={2}>
        <span>{outcome.text}</span>
        <Typography.Text type="secondary">这不是成功结果；账务状态未改变。请核对对象、revision 与证据后重试。</Typography.Text>
      </Space>}
    />
  </div>;
  return <div aria-live="polite" aria-atomic="true" data-commercial-outcome="success">
    <Alert type="success" showIcon title="服务端已接受这次操作" description={<Typography.Text code copyable={{ text: outcome.text }}>{outcome.text}</Typography.Text>} />
  </div>;
}

export type CommercialOperationId =
  | "createPrivateTrialInvite"
  | "createPrivateTrialEligibility"
  | "approvePrivateTrialEligibility"
  | "createPrivateTrialOrder"
  | "completePrivateTrialValidation"
  | "preparePrivateTrialCredit"
  | "approvePrivateTrialCredit"
  | "createPrivateTrialConversionOrder"
  | "verifyCommercialOrderTransfer"
  | "verifyPrivateTrialPayment"
  | "verifyPrivateTrialTransfer"
  | "requestCommercialRefund"
  | "approveCommercialRefund"
  | "completeCommercialRefund";

/**
 * Commands that move money or points the moment the server accepts them and
 * cannot be undone from this console: they require a second, explicit confirmation.
 */
export const irreversibleCommercialOperations = [
  "verifyCommercialOrderTransfer",
  "verifyPrivateTrialPayment",
  "verifyPrivateTrialTransfer",
  "completeCommercialRefund",
] as const satisfies readonly CommercialOperationId[];

export type IrreversibleCommercialOperation = (typeof irreversibleCommercialOperations)[number];

export interface CommercialOperationDecision {
  readonly requiresConfirmation: boolean;
  readonly execute: boolean;
}

/** Gate between an operator click and a commercial command. */
export function commercialOperationDecision(id: CommercialOperationId, confirmed: boolean): CommercialOperationDecision {
  const requiresConfirmation = (irreversibleCommercialOperations as readonly CommercialOperationId[]).includes(id);
  return { requiresConfirmation, execute: !requiresConfirmation || confirmed };
}

/** A dangerous command waiting for its confirmation dialog to be accepted. */
export interface PendingCommercialOperation {
  readonly id: IrreversibleCommercialOperation;
  readonly title: string;
  readonly objectLabel: string;
  readonly objectValue: string;
  readonly scope: string;
  readonly impact: string;
  readonly defaultReason: string;
  readonly run: (reason: string) => Promise<unknown>;
}
