import { Alert, Button, Empty, Skeleton } from "antd";
import { useEffect, useId, useRef, type ReactNode } from "react";

export type OpsDataStateKind = "loading" | "empty" | "error" | "ready";

interface OpsDataStateProps {
  state: OpsDataStateKind;
  children?: ReactNode;
  title?: string;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
}

export function OpsDataState({ state, children, title, description, onRetry, retryLabel = "重试" }: OpsDataStateProps) {
  const errorRef = useRef<HTMLDivElement>(null);
  const errorTitleId = useId();
  const errorDescriptionId = useId();
  useEffect(() => {
    if (state === "error") errorRef.current?.focus({ preventScroll: true });
  }, [state]);
  if (state === "ready") return <div className="ops-data-state" data-state="ready">{children}</div>;
  if (state === "loading") {
    return <div className="ops-data-state" data-state="loading" role="status" aria-live="polite" aria-busy="true" aria-label={description || "正在加载运营数据"}><Skeleton active paragraph={{ rows: 4 }} /></div>;
  }
  if (state === "error") {
    const resolvedTitle = title || "数据加载失败";
    const resolvedDescription = description || "暂时无法读取运营数据，请重试。";
    const recover = onRetry ?? (() => window.location.reload());
    return <div ref={errorRef} tabIndex={-1} className="ops-data-state" data-state="error" data-focus-target="error-summary" aria-labelledby={errorTitleId} aria-describedby={errorDescriptionId}>
      <Alert role="alert" aria-live="assertive" aria-atomic="true" type="error" showIcon title={<span id={errorTitleId}>{resolvedTitle}</span>} description={<span id={errorDescriptionId}>{resolvedDescription}</span>} action={<Button htmlType="button" className="ops-error-retry" aria-label={retryLabel} onClick={recover}>{retryLabel}</Button>} />
    </div>;
  }
  return <div className="ops-data-state" data-state="empty" role="status"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={description || title || "当前没有可显示的数据"}>{children}</Empty></div>;
}

export function OpsLoadingState({ label = "正在加载运营数据" }: { label?: string }) {
  return <OpsDataState state="loading" description={label} />;
}

export function OpsEmptyState({ description, children }: { description?: string; children?: ReactNode }) {
  return <OpsDataState state="empty" description={description}>{children}</OpsDataState>;
}

export function OpsErrorState({ title, description, onRetry, retryLabel }: Omit<OpsDataStateProps, "state" | "children">) {
  return <OpsDataState state="error" title={title} description={description} onRetry={onRetry} retryLabel={retryLabel} />;
}
