import { ClockCircleOutlined } from "@ant-design/icons";
import { Button, Tag, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import type { OpsSession } from "../../types/ops.js";
import {
  activeJitGrantForNow,
  formatJitRemaining,
  jitScopeLabel,
  jitUseBudgetLabel,
  nextJitExpiryAt,
} from "../../authz/jitGrant.js";

/**
 * Persistent warning bar for a controlled (temporary/JIT) support session.
 *
 * Two things depend on this being mounted:
 * - the design contract in `doc/todo/ops/ops-rbac-ui-design-2026-08-31.md` §3.2
 *   requires the controlled session's scope and remaining time to stay visible
 *   and to offer an explicit exit;
 * - it is the only trigger for the expiry cleanup. When the server-projected
 *   grant lapses, the console must stop showing the data it loaded under that
 *   grant and re-read the authorization projection instead of continuing to
 *   trust a snapshot the server no longer honours.
 *
 * The countdown text is `aria-hidden`: it changes every second, so announcing it
 * would flood assistive technology. The announcement is the absolute expiry
 * time, which only changes when the grant itself changes.
 */
/** The moment the client must stop trusting the projection it holds. */
export function jitExpiryReached(expiryAt: number | undefined, now: number): boolean {
  return expiryAt !== undefined && now >= expiryAt;
}

export function ControlledSessionBar({
  session,
  onExpired,
  onExit,
}: {
  session?: OpsSession;
  onExpired?: () => void;
  onExit?: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const expiryAt = nextJitExpiryAt(session?.temporary_grants);
  // Hold the callback in a ref: the controller passes a fresh arrow on every
  // render, and re-running the effect on that identity would re-arm an already
  // fired deadline (and, once past it, reload in a loop).
  const onExpiredRef = useRef(onExpired);
  onExpiredRef.current = onExpired;
  const notifiedExpiryRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (expiryAt === undefined) {
      notifiedExpiryRef.current = undefined;
      return undefined;
    }
    if (notifiedExpiryRef.current === expiryAt) return undefined;
    const expire = () => {
      if (notifiedExpiryRef.current === expiryAt) return;
      notifiedExpiryRef.current = expiryAt;
      onExpiredRef.current?.();
    };
    if (jitExpiryReached(expiryAt, Date.now())) {
      expire();
      return undefined;
    }
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (jitExpiryReached(expiryAt, current)) {
        window.clearInterval(timer);
        expire();
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [expiryAt]);

  const grant = activeJitGrantForNow(session?.temporary_grants, now);
  if (!grant) return null;

  const expiresAt = grant.expires_at ? Date.parse(grant.expires_at) : Number.NaN;
  const hasDeadline = Number.isFinite(expiresAt);
  const remaining = hasDeadline ? formatJitRemaining(expiresAt - now) : undefined;
  const budget = jitUseBudgetLabel(grant);

  return (
    <section className="ops-controlled-session-bar" aria-label="受控会话">
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        受控会话已启用：{grant.access_mode === "write" ? "可写" : "只读"}；范围 {jitScopeLabel(grant)}；
        {hasDeadline ? `到期时间 ${grant.expires_at}。` : "会话结束时失效。"}
      </span>
      <Tag color="gold" icon={<ClockCircleOutlined aria-hidden="true" />}>
        受控会话 · {grant.access_mode === "write" ? "可写" : "只读"}
      </Tag>
      <Typography.Text className="ops-controlled-session-scope">
        范围 {jitScopeLabel(grant)}
      </Typography.Text>
      <Typography.Text type="secondary" aria-hidden="true">
        {remaining ? `剩余 ${remaining}` : "会话结束失效"}
        {budget ? ` · ${budget}` : ""}
      </Typography.Text>
      {onExit ? (
        <Button
          size="small"
          onClick={onExit}
          aria-label="退出受控会话并清除本机已加载的授权数据"
        >
          退出受控会话
        </Button>
      ) : null}
    </section>
  );
}
