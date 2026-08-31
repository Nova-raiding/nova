import { Component, type ErrorInfo, type ReactNode } from "react";
import { Alert, Button } from "antd";

interface Props { children: ReactNode; resetKey: string }
interface State { error?: Error }

export function isLazyChunkError(error: Error): boolean {
  return /chunk|dynamically imported module|failed to fetch module script|importing a module script/i.test(`${error.name} ${error.message}`);
}

export class OpsPageBoundary extends Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ops page render failed", error, info.componentStack);
  }

  componentDidUpdate(previous: Props) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: undefined });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const chunkFailed = isLazyChunkError(this.state.error);
    return (
      <Alert
        role="alert"
        type="error"
        showIcon
        title={chunkFailed ? "页面资源加载失败" : "当前页面渲染失败"}
        description={chunkFailed
          ? "可能刚好遇到版本发布或网络中断。重新加载会获取最新页面资源。"
          : "其他运营数据未受影响。请重试；若问题持续，请保留当前页面与时间后联系平台运维。"}
        action={<Button size="small" onClick={() => chunkFailed ? window.location.reload() : this.setState({ error: undefined })}>{chunkFailed ? "重新加载控制台" : "重试页面"}</Button>}
      />
    );
  }
}
