import { Alert, Button } from "antd";
import { useEffect, useMemo, useRef } from "react";
import { presentOpsError } from "./opsErrorPresentation.js";

interface OpsPageErrorProps {
  error: unknown;
  onRetry?: () => void;
  onReauthenticate?: () => void;
  onContactSupport?: () => void;
}

export function OpsPageError({ error, onRetry, onReauthenticate, onContactSupport }: OpsPageErrorProps) {
  const errorRef = useRef<HTMLDivElement>(null);
  const presentation = useMemo(() => presentOpsError(error), [error]);
  useEffect(() => {
    if (presentation) errorRef.current?.focus({ preventScroll: true });
  }, [presentation]);
  if (!presentation) return null;

  const primaryAction = presentation.recovery === "reauthenticate"
    ? <Button size="small" aria-label="重新登录运营后台" onClick={onReauthenticate ?? (() => window.location.reload())}>重新登录</Button>
    : presentation.recovery === "contact_support"
      ? onContactSupport
        ? <Button size="small" aria-label="联系平台支持" onClick={onContactSupport}>联系支持</Button>
        : undefined
      : onRetry
        ? <Button size="small" aria-label="重试加载运营数据" onClick={onRetry}>重试</Button>
        : undefined;

  const hasDiagnostics = Boolean(presentation.code || presentation.requestId || presentation.traceId || presentation.decisionId || presentation.reasonCode || presentation.obligationsMissing?.length);
  return (
    <div ref={errorRef} tabIndex={-1} className="ops-page-error" data-state="error">
      <Alert
        role="alert"
        aria-live="assertive"
        type="error"
        showIcon
        title={presentation.title}
        description={
          <div>
            <p>{presentation.description}</p>
            {hasDiagnostics ? (
              <details>
                <summary>查看诊断信息</summary>
                <dl>
                  {presentation.code ? <><dt>错误代码</dt><dd><code>{presentation.code}</code></dd></> : null}
                  {presentation.requestId ? <><dt>请求 ID</dt><dd><code>{presentation.requestId}</code></dd></> : null}
                  {presentation.traceId ? <><dt>追踪 ID</dt><dd><code>{presentation.traceId}</code></dd></> : null}
                  {presentation.decisionId ? <><dt>决策 ID</dt><dd><code>{presentation.decisionId}</code></dd></> : null}
                  {presentation.reasonCode ? <><dt>决策原因</dt><dd><code>{presentation.reasonCode}</code></dd></> : null}
                  {presentation.obligationsMissing?.length ? <><dt>缺失义务</dt><dd><code>{presentation.obligationsMissing.join(", ")}</code></dd></> : null}
                </dl>
              </details>
            ) : null}
          </div>
        }
        action={primaryAction}
      />
    </div>
  );
}
