import { useEffect, useMemo, useRef } from "react";
import { Alert, Button, Descriptions, Modal, Space, Tag, Typography } from "antd";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel.js";
import { canReconcileImageExecution, summarizeImageExecutionEvidence } from "./imageExecutionEvidence.js";

interface ImageExecutionEvidenceModalProps {
  execution?: OpsConsoleModel["marketingQueue"]["imageExecutions"][number];
  exporting: boolean;
  onExport: () => void;
  onClose: () => void;
  onOpenReconcile: () => void;
}

function stateColor(state: string) {
  if (["failed", "rejected", "unknown", "outcome_unknown", "manual_attention", "blocked"].includes(state)) return "red";
  if (["succeeded", "published", "completed", "passed", "ready"].includes(state)) return "green";
  return "orange";
}

function queueStateLabel(state: string) {
  return ({
    queued: "排队中",
    running: "处理中",
    processing: "处理中",
    archiving: "归档中",
    scanning: "安全扫描中",
    provider_reserved: "生成请求已登记，等待提交",
    provider_dispatching: "正在提交模型请求，等待受理确认",
    dispatching: "正在提交模型请求，等待受理确认",
    provider_started: "模型已受理，等待结果确认",
    failed: "失败",
    rejected: "已驳回",
    unknown: "待对账",
    outcome_unknown: "结果待对账",
    manual_attention: "待人工处理",
    blocked: "已阻断",
    succeeded: "已完成",
    completed: "已完成",
    published: "已发布",
    ready: "待处理",
  } as Record<string, string>)[state] ?? "状态待确认";
}

export function ImageExecutionEvidenceModal({
  execution,
  exporting,
  onExport,
  onClose,
  onOpenReconcile,
}: ImageExecutionEvidenceModalProps) {
  const summaryRef = useRef<HTMLDivElement>(null);
  const gate = useMemo(() => execution ? summarizeImageExecutionEvidence(execution) : undefined, [execution]);
  const reconcileEnabled = canReconcileImageExecution(execution);

  useEffect(() => {
    if (gate?.blocked) summaryRef.current?.focus({ preventScroll: true });
  }, [gate?.blocked]);

  return (
    <Modal
      open={Boolean(execution)}
      title="图片执行证据"
      destroyOnHidden
      onCancel={onClose}
      footer={execution ? (
        <Space wrap aria-label="图片执行证据操作">
          {reconcileEnabled ? (
            <Button
              type="primary"
              aria-label="打开人工收口"
              onClick={() => {
                onClose();
                onOpenReconcile();
              }}
            >
              打开人工收口
            </Button>
          ) : (
            <Typography.Text type="secondary">仅观测，不可重复生成</Typography.Text>
          )}
          <Button loading={exporting} aria-label="导出脱敏证据包" onClick={onExport}>导出脱敏证据包</Button>
          <Button aria-label="关闭图片执行证据" onClick={onClose}>关闭</Button>
        </Space>
      ) : null}
    >
      {execution && gate ? (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          {gate.blocked ? (
            <div ref={summaryRef} tabIndex={-1} role="alert" aria-live="assertive">
              <Alert
                type="error"
                showIcon
                message="图片执行仍被阻断"
                description={
                  <div>
                    <p>服务端还没有返回完整的 request / usage / cost / error evidence，桌面端只能展示诊断和恢复路径，不能把这次执行视为成功。</p>
                    <ul>
                      {gate.blockers.map((item) => <li key={item}>{item}</li>)}
                    </ul>
                    <p>恢复路径：</p>
                    <ul>
                      {gate.recovery.map((item) => <li key={item}>{item}</li>)}
                    </ul>
                  </div>
                }
              />
            </div>
          ) : (
            <Alert
              type="success"
              showIcon
              role="status"
              aria-live="polite"
              message="证据门禁已满足"
              description="已返回 request / usage / cost evidence；若后续状态变化，仍以服务端重新投影的证据为准。"
            />
          )}
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="Job ID">{execution.jobId}</Descriptions.Item>
            <Descriptions.Item label="Task / Product">{execution.taskId ?? "未绑定任务"} / {execution.productId}</Descriptions.Item>
            <Descriptions.Item label="执行状态"><Tag color={stateColor(execution.state)}>{queueStateLabel(execution.state)}</Tag></Descriptions.Item>
            <Descriptions.Item label="Relay 状态">{gate.relayStatus}</Descriptions.Item>
            <Descriptions.Item label="归档状态">{execution.archiveState}</Descriptions.Item>
            <Descriptions.Item label="执行尝试">{execution.attempt}</Descriptions.Item>
            <Descriptions.Item label="Provider request ID">{execution.providerRequestId ?? "尚未确认"}</Descriptions.Item>
            <Descriptions.Item label="请求事件 ID">{execution.eventId}</Descriptions.Item>
            {gate.evidence.map((item) => (
              <Descriptions.Item key={item.key} label={item.label}>
                <Tag color={item.present ? "green" : item.required ? "red" : "default"}>
                  {item.present ? "已返回" : item.required ? "未返回" : "当前未要求"}
                </Tag>
                <Typography.Text type={item.present ? "secondary" : item.required ? "danger" : "secondary"} style={{ marginInlineStart: 8 }}>
                  {item.detail}
                </Typography.Text>
              </Descriptions.Item>
            ))}
            <Descriptions.Item label="错误">{execution.errorCode ?? "无"}{execution.errorMessage ? `：${execution.errorMessage}` : ""}</Descriptions.Item>
            <Descriptions.Item label="下一步">{reconcileEnabled ? "先补齐证据，再打开人工收口；禁止重复生成。" : execution.nextAction}</Descriptions.Item>
            <Descriptions.Item label="告警/最后动作">{execution.alertState === "open" ? "超时待处理" : "观察中"} · {execution.lastAction}</Descriptions.Item>
            <Descriptions.Item label="关闭依据">{execution.closureEvidence ?? "尚未关闭"}</Descriptions.Item>
            <Descriptions.Item label="对账状态">{execution.reconciliationStatus ?? "未收口"} · revision {execution.reconciliationRevision ?? "—"}</Descriptions.Item>
            <Descriptions.Item label="对账证据">{execution.reconciliationEvidenceRef ?? "未提供"}</Descriptions.Item>
            <Descriptions.Item label="对账原因">{execution.reconciliationReason ?? "未提供"}</Descriptions.Item>
            <Descriptions.Item label="更新时间">{new Date(execution.updatedAt).toLocaleString()}</Descriptions.Item>
          </Descriptions>
        </Space>
      ) : null}
    </Modal>
  );
}
