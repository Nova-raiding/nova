import type { ModalFuncProps } from "antd";

/**
 * Keyboard-focus policy for antd confirmation dialogs.
 *
 * antd 6 puts focus on the *confirm* button unless it is told otherwise —
 * `node_modules/antd/es/modal/ConfirmDialog.js:74-76`:
 *
 *   const base = focusable?.autoFocusButton || autoFocusButton;
 *   return base || base === null ? base : 'ok';
 *
 * `_util/ActionButton.js` then calls `buttonRef.current?.focus()` from a
 * `setTimeout`, so with the default a stray Enter fires the mutation behind the
 * dialog. `apps/ops-console/src` used to pass neither `focusable` nor the
 * deprecated top-level `autoFocusButton`, which is why every confirmation had
 * its danger button focused.
 *
 * Destructive operations therefore opt into `focusable.autoFocusButton:
 * "cancel"`. The top-level `autoFocusButton` still works but is marked
 * `@deprecated` in antd 6 in favour of `focusable.autoFocusButton`.
 */

export type ConfirmAutoFocusButton = "ok" | "cancel" | null;

/** How costly it is to undo the operation behind a confirmation. */
export type ConfirmRisk = "destructive" | "additive" | "read-only";

/** Every `modal.confirm` surface in the ops console, classified below. */
export type OpsConfirmAction =
  | "store.revoke"
  | "billing.refund"
  | "delivery.record.archive"
  | "billing.reconciliation.run"
  | "support.ticket.create";

/**
 * Risk table for the console's confirmations.
 *
 * - destructive: money leaves the platform or an authorization/delivery record
 *   stops working for the customer. Must focus cancel.
 * - additive: creates a new record (a support ticket); Enter is safe.
 * - read-only: idempotent query that only settles state the provider already
 *   reported; kept as an informational confirmation.
 */
export const OPS_CONFIRM_RISK: Record<OpsConfirmAction, ConfirmRisk> = {
  "store.revoke": "destructive",
  "billing.refund": "destructive",
  "delivery.record.archive": "destructive",
  "billing.reconciliation.run": "read-only",
  "support.ticket.create": "additive",
};

export interface ConfirmFocusOptions {
  /** @deprecated antd 6 field kept for callers that have not migrated. */
  autoFocusButton?: ConfirmAutoFocusButton;
  focusable?: { autoFocusButton?: ConfirmAutoFocusButton } | null;
}

/**
 * Mirror of antd's own resolution order. Production code must not depend on it,
 * but asserting on it keeps the intent testable without rendering a dialog and
 * makes an upstream change to antd's fallback fail loudly here.
 */
export function resolveConfirmAutoFocus(options: ConfirmFocusOptions = {}): ConfirmAutoFocusButton {
  const base = options.focusable?.autoFocusButton || options.autoFocusButton;
  return base || base === null ? base : "ok";
}

/** Whether the operation is destructive enough to require a confirmation. */
export function requiresConfirmation(risk: ConfirmRisk): boolean {
  return risk !== "read-only";
}

/** Default focus for a risk class: destructive dialogs must not focus confirm. */
export function confirmFocusForRisk(risk: ConfirmRisk): ConfirmAutoFocusButton {
  return risk === "destructive" ? "cancel" : "ok";
}

export type ConfirmPolicyProps = Pick<ModalFuncProps, "okButtonProps" | "focusable">;

/**
 * Confirmation props for a classified action, spread into `modal.confirm({...})`.
 * Non-destructive actions contribute nothing, so the call site still declares
 * its classification instead of drifting silently.
 */
export function confirmPolicyPropsFor(action: OpsConfirmAction): ConfirmPolicyProps {
  const risk = OPS_CONFIRM_RISK[action];
  return risk === "destructive"
    ? { okButtonProps: { danger: true }, focusable: { autoFocusButton: confirmFocusForRisk(risk) } }
    : {};
}
