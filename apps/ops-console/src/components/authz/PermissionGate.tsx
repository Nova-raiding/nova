import { Alert } from "antd";
import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";
import { useAuthorization } from "../../authz/AuthorizationProvider.js";

export function PermissionGate({
  capability,
  anyOf,
  behavior = "hide",
  children,
  fallback,
  disabledReason,
}: {
  capability?: string;
  anyOf?: readonly string[];
  behavior?: "hide" | "readonly" | "disabled";
  children: ReactNode | ((state: { allowed: boolean; readOnly: boolean }) => ReactNode);
  fallback?: ReactNode;
  disabledReason?: string;
}) {
  const authorization = useAuthorization();
  const disabledReasonId = useId();
  const required = anyOf ?? (capability ? [capability] : []);
  const allowed = required.length > 0 && authorization.canAny(required);
  if (typeof children === "function") return <>{children({ allowed, readOnly: !allowed })}</>;
  if (allowed) return <>{children}</>;
  if (fallback !== undefined) return <>{fallback}</>;
  if (behavior === "disabled") {
    const reason = disabledReason ?? `当前会话缺少能力：${required.join(" 或 ")}`;
    const disabledChild = isValidElement(children)
      ? cloneElement(children as ReactElement<{ disabled?: boolean; "aria-describedby"?: string }>, {
          disabled: true,
          "aria-describedby": disabledReasonId,
        })
      : children;
    return (
      <span
        className="permission-disabled"
        tabIndex={0}
        aria-label="操作暂不可用"
        aria-describedby={disabledReasonId}
        title={reason}
      >
        {disabledChild}
        <span id={disabledReasonId} className="sr-only">{reason}</span>
      </span>
    );
  }
  if (behavior === "readonly") {
    const scopes = required.map((item) => authorization.scopeFor(item)).filter(Boolean);
    const scopeText = scopes.length
      ? `当前授权范围：${scopes.map((scope) => `${scope!.kind}:${scope!.id ?? scope!.ids?.join(",") ?? "未识别"}`).join("、")}`
      : "当前授权范围未返回";
    return <Alert type="info" showIcon title="当前范围为只读" description={<span>{`缺少能力：${required.join(" 或 ")}`} · {scopeText}</span>} />;
  }
  return null;
}
