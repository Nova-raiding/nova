import { Alert, Button, Descriptions, Input, Modal, Space, Typography } from "antd";
import { useEffect, useId, useRef, type RefObject } from "react";

export interface DangerActionModalProps {
  open: boolean;
  title: string;
  objectLabel: string;
  objectValue: string;
  scope: string;
  impact: string;
  revision?: string | number;
  reason: string;
  onReasonChange: (reason: string) => void;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  loading?: boolean;
  error?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  reasonLabel?: string;
  reasonHint?: string;
  triggerRef?: RefObject<HTMLElement | null>;
}

/**
 * Shared confirmation surface for destructive or cross-scope operations.
 * It deliberately owns presentation only; the caller supplies the server
 * decision, revision and mutation callback.
 */
export function DangerActionModal({
  open,
  title,
  objectLabel,
  objectValue,
  scope,
  impact,
  revision,
  reason,
  onReasonChange,
  onConfirm,
  onCancel,
  loading = false,
  error,
  confirmLabel = "确认执行",
  cancelLabel = "取消",
  reasonLabel = "操作原因",
  reasonHint = "请填写原因，便于审计和后续恢复。",
  triggerRef,
}: DangerActionModalProps) {
  const errorRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const reasonId = useId();
  const errorId = useId();

  useEffect(() => {
    if (!error) return undefined;
    const frame = window.requestAnimationFrame(() => errorRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [error]);

  return (
    <Modal
      open={open}
      title={<span id={titleId}>{title}</span>}
      aria-labelledby={titleId}
      onCancel={onCancel}
      destroyOnHidden={false}
      afterOpenChange={(visible) => {
        if (!visible) window.requestAnimationFrame(() => triggerRef?.current?.focus({ preventScroll: true }));
      }}
      footer={null}
    >
      <Space orientation="vertical" size="middle" className="full-width">
        <Descriptions bordered size="small" column={1} aria-label="危险操作上下文">
          <Descriptions.Item label={objectLabel}>{objectValue}</Descriptions.Item>
          <Descriptions.Item label="作用范围">{scope}</Descriptions.Item>
          <Descriptions.Item label="影响">{impact}</Descriptions.Item>
          {revision !== undefined ? <Descriptions.Item label="当前 revision"><Typography.Text code>{revision}</Typography.Text></Descriptions.Item> : null}
        </Descriptions>
        <Typography.Text type="secondary">提交后将写入审计记录；请确认对象、范围和影响均正确。</Typography.Text>
        {error ? (
          <div ref={errorRef} tabIndex={-1} role="alert" aria-live="assertive" aria-atomic="true" aria-label="危险操作失败" aria-describedby={errorId}>
            <Alert type="error" showIcon message="操作未完成" description={<span id={errorId}>{error} 请检查原因后重试。</span>} />
          </div>
        ) : null}
        <label htmlFor={reasonId}>{reasonLabel}</label>
        <Input.TextArea
          id={reasonId}
          value={reason}
          onChange={(event) => onReasonChange(event.target.value)}
          aria-describedby={`${reasonId}-hint${error ? ` ${errorId}` : ""}`}
          aria-invalid={Boolean(error)}
          autoFocus
          rows={3}
          disabled={loading}
          placeholder={reasonHint}
        />
        <Typography.Text id={`${reasonId}-hint`} type="secondary">{reasonHint}</Typography.Text>
        <Space className="full-width" style={{ justifyContent: "flex-end" }}>
          <Button htmlType="button" onClick={onCancel} disabled={loading}>{cancelLabel}</Button>
          <Button htmlType="button" danger type="primary" loading={loading} disabled={!reason.trim() || loading} aria-busy={loading} onClick={() => void onConfirm()}>{loading ? "正在提交" : confirmLabel}</Button>
        </Space>
      </Space>
    </Modal>
  );
}
