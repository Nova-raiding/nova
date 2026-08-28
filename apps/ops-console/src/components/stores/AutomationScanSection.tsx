import {
  Alert,
  Button,
  Card,
  Col,
  Input,
  InputNumber,
  Row,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import type { Dispatch, SetStateAction } from "react";
import type { AutomationPolicy, AutomationScan } from "../../types/ops";

interface AutomationScanSectionProps {
  automationPolicy: AutomationPolicy | undefined;
  automationScan: AutomationScan | undefined;
  canQueue: boolean;
  setAutomationPolicy: Dispatch<SetStateAction<AutomationPolicy | undefined>>;
  onScan: () => Promise<void>;
  onUpdate: (enabled: boolean, reason?: string) => Promise<void>;
}

export function AutomationScanSection({
  automationPolicy,
  automationScan,
  canQueue,
  setAutomationPolicy,
  onScan,
  onUpdate,
}: AutomationScanSectionProps) {
  return (
    <>
      <Card
        title="店铺优化建议"
        size="small"
        extra={
          <Tag
            color={automationScan?.recommendations?.length ? "orange" : "green"}
          >
            {automationScan?.recommendations?.length ?? 0} 条
          </Tag>
        }
      >
        <Table
          rowKey="id"
          pagination={{ pageSize: 6 }}
          dataSource={automationScan?.recommendations ?? []}
          columns={[
            {
              title: "优先级",
              dataIndex: "priority",
              render: (value: string) => (
                <Tag color={value === "high" ? "red" : "orange"}>{value}</Tag>
              ),
            },
            { title: "建议", dataIndex: "title" },
            { title: "下一步", dataIndex: "action" },
            { title: "入口", dataIndex: "method" },
            {
              title: "边界",
              render: (
                _: unknown,
                row: NonNullable<AutomationScan["recommendations"]>[number],
              ) =>
                row.requiresInteractiveConfirmation ? (
                  <Tag color="blue">需交互确认</Tag>
                ) : (
                  <Tag>只读</Tag>
                ),
            },
          ]}
        />
      </Card>
      <Card
        title="店铺自动化运营"
        extra={
          <Space>
            <Tag color={automationPolicy?.enabled ? "green" : "orange"}>
              {automationPolicy?.enabled ? "扫描已开启" : "已暂停"}
            </Tag>
            <Button
              size="small"
              disabled={!canQueue}
              onClick={() => void onScan()}
            >
              立即扫描
            </Button>
            <Button
              size="small"
              type="primary"
              disabled={!canQueue || !automationPolicy}
              onClick={() => void onUpdate(automationPolicy?.enabled ?? false)}
            >
              保存策略
            </Button>
            <Switch
              disabled={!canQueue}
              checked={automationPolicy?.enabled ?? false}
              onChange={(checked) => void onUpdate(checked)}
            />
          </Space>
        }
      >
        <Row gutter={[16, 16]}>
          <Col xs={12} md={6}>
            <Statistic
              title="扫描商品"
              value={automationScan?.counts.products ?? "-"}
            />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title="发布任务"
              value={automationScan?.counts.publishJobs ?? "-"}
            />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title="风险项"
              value={automationScan?.counts.risks ?? "-"}
            />
          </Col>
          <Col xs={24} md={6}>
            <Typography.Text type="secondary">
              模式：同步扫描 + 风险告警 + 人工重试
              <br />
              不会无人值守自动重发
            </Typography.Text>
          </Col>
        </Row>
        <Space wrap style={{ marginTop: 16 }}>
          <Typography.Text>执行频率（分钟）</Typography.Text>
          <InputNumber
            aria-label="自动化执行频率"
            min={5}
            max={1440}
            value={automationPolicy?.frequencyMinutes ?? 60}
            disabled={!canQueue || !automationPolicy}
            onChange={(value) =>
              setAutomationPolicy((current) =>
                current
                  ? { ...current, frequencyMinutes: value ?? 60 }
                  : current,
              )
            }
          />
          <Typography.Text>重试上限</Typography.Text>
          <InputNumber
            aria-label="自动化重试上限"
            min={0}
            max={5}
            value={automationPolicy?.retryLimit ?? 2}
            disabled={!canQueue || !automationPolicy}
            onChange={(value) =>
              setAutomationPolicy((current) =>
                current ? { ...current, retryLimit: value ?? 2 } : current,
              )
            }
          />
          <Typography.Text>执行窗口</Typography.Text>
          <Input
            aria-label="自动化执行窗口开始"
            placeholder="09:00"
            style={{ width: 90 }}
            value={automationPolicy?.windowStart ?? ""}
            disabled={!canQueue || !automationPolicy}
            onChange={(event) =>
              setAutomationPolicy((current) =>
                current
                  ? { ...current, windowStart: event.target.value }
                  : current,
              )
            }
          />
          <Typography.Text>至</Typography.Text>
          <Input
            aria-label="自动化执行窗口结束"
            placeholder="18:00"
            style={{ width: 90 }}
            value={automationPolicy?.windowEnd ?? ""}
            disabled={!canQueue || !automationPolicy}
            onChange={(event) =>
              setAutomationPolicy((current) =>
                current
                  ? { ...current, windowEnd: event.target.value }
                  : current,
              )
            }
          />
          <Typography.Text type="secondary">
            留空表示全天；窗口外仅延期并记录审计。
          </Typography.Text>
        </Space>
        {automationPolicy?.pauseReason && (
          <Alert type="warning" showIcon title={automationPolicy.pauseReason} />
        )}
        {automationScan?.risks.length ? (
          <Table
            rowKey={(row) =>
              `${row.kind}:${row.product_id ?? row.publish_job_id ?? row.message}`
            }
            pagination={{ pageSize: 6 }}
            dataSource={automationScan.risks}
            columns={[
              { title: "风险类型", dataIndex: "kind" },
              {
                title: "对象",
                render: (_: unknown, row: AutomationScan["risks"][number]) =>
                  row.product_id ?? row.publish_job_id ?? "-",
              },
              { title: "说明", dataIndex: "message" },
            ]}
          />
        ) : (
          <Typography.Text type="secondary">暂无扫描风险。</Typography.Text>
        )}
      </Card>
    </>
  );
}
