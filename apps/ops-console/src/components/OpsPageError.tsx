import { Alert, Button } from "antd";

interface OpsPageErrorProps {
  error: string;
  onRetry: () => void;
}

export function OpsPageError({ error, onRetry }: OpsPageErrorProps) {
  if (!error) return null;
  return (
    <Alert
      type="error"
      showIcon
      title="无法加载运营数据"
      description={error}
      action={
        <Button size="small" onClick={onRetry}>
          重试
        </Button>
      }
    />
  );
}
