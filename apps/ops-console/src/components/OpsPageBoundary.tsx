import { Component, createRef, type ErrorInfo, type ReactNode } from "react";
import { Alert, Button } from "antd";

interface Props { children: ReactNode; resetKey: string }
interface State { error?: Error }

export function isLazyChunkError(error: Error): boolean {
  return /chunk|dynamically imported module|failed to fetch module script|importing a module script/i.test(`${error.name} ${error.message}`);
}

export function pageBoundaryRecoveryLabel(chunkFailed: boolean) {
  return chunkFailed ? "重新加载控制台" : "重试页面";
}

export class OpsPageBoundary extends Component<Props, State> {
  state: State = {};
  private readonly errorRef = createRef<HTMLDivElement>();

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ops page render failed", error, info.componentStack);
    // Move focus to the recovery summary so keyboard users are not left at a
    // removed control after a page-level render failure.
    this.errorRef.current?.focus({ preventScroll: true });
  }

  componentDidUpdate(previous: Props) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: undefined });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const chunkFailed = isLazyChunkError(this.state.error);
    const titleId = "ops-page-boundary-error-title";
    const descriptionId = "ops-page-boundary-error-description";
    const recoveryLabel = pageBoundaryRecoveryLabel(chunkFailed);
    return (
      <div
        ref={this.errorRef}
        className="ops-page-boundary-error"
        data-state="error"
        data-focus-target="error-summary"
        tabIndex={-1}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <Alert
          role="alert"
          aria-live="assertive"
          type="error"
          showIcon
          title={<span id={titleId}>{chunkFailed ? "页面资源加载失败" : "当前页面渲染失败"}</span>}
          description={<span id={descriptionId}>{chunkFailed
            ? "可能刚好遇到版本发布或网络中断。重新加载会获取最新页面资源。"
            : "其他运营数据未受影响。请重试；若问题持续，请保留当前页面与时间后联系平台运维。"}</span>}
          action={<Button size="small" style={{ minHeight: 44 }} aria-label={recoveryLabel} onClick={() => chunkFailed ? window.location.reload() : this.setState({ error: undefined })}>{recoveryLabel}</Button>}
        />
      </div>
    );
  }
}
