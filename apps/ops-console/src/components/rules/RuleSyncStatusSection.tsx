import { ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Table, Tag, Typography } from "antd";
import { useEffect, useId, useRef } from "react";
import type { RuleSyncStatus } from "../../types/ops";

interface RuleSyncStatusSectionProps {
  loading: boolean;
  statuses: RuleSyncStatus[];
  error?: string | null;
  onRefresh: () => void;
}

const statePresentation: Record<RuleSyncStatus["state"], { color: string; label: string }> = {
  ready: { color: "green", label: "新鲜" },
  stale: { color: "orange", label: "已过期" },
  not_configured: { color: "red", label: "未配置" },
};

export function RuleSyncStatusSection({
  loading,
  statuses,
  error,
  onRefresh,
}: RuleSyncStatusSectionProps) {
  const blocked = statuses.filter((item) => item.state !== "ready").length;
  const errorRef = useRef<HTMLDivElement>(null);
  const errorTitleId = useId();
  const errorDescriptionId = useId();

  useEffect(() => {
    if (error) errorRef.current?.focus({ preventScroll: true });
  }, [error]);

  return (
    <section aria-label="六平台规则同步" aria-busy={loading}>
      <span className="ops-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {loading ? "正在刷新六个平台规则同步状态，请稍候" : statuses.length > 0 ? `已读取 ${statuses.length} 个平台的规则同步状态` : ""}
      </span>
      <Card
        title="六平台规则同步"
        extra={
          <Button
            icon={<ReloadOutlined aria-hidden="true" />}
            loading={loading}
            disabled={loading}
            aria-busy={loading}
            aria-label={loading ? "正在刷新规则同步状态" : "刷新规则同步状态"}
            style={{ minHeight: 44 }}
            onClick={onRefresh}
          >
            {loading ? "刷新中" : "刷新状态"}
          </Button>
        }
      >
      {error ? (
        <div
          ref={errorRef}
          tabIndex={-1}
          aria-label="规则同步错误摘要"
          aria-labelledby={errorTitleId}
          aria-describedby={errorDescriptionId}
          data-focus-target="error-summary"
        >
          <Alert
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
            type="error"
            showIcon
            title={<span id={errorTitleId}>规则同步状态读取失败</span>}
            description={<span id={errorDescriptionId}>{error}</span>}
            action={
              <Button htmlType="button" style={{ minHeight: 44 }} onClick={onRefresh}>
                重试规则同步
              </Button>
            }
          />
        </div>
      ) : null}
      <Alert
        type={statuses.length > 0 && blocked === 0 ? "success" : "warning"}
        showIcon
        title={
          statuses.length === 0
            ? "规则同步状态尚未加载"
            : blocked === 0
              ? "六个平台规则均在检查窗口内"
              : `${blocked} 个平台未通过规则新鲜度门禁`
        }
        description="生成与发布前会按当前店铺平台调用对应规则；未配置或过期时必须保持阻断或人工复核，不能把旧规则视为有效。"
      />
      <Table<RuleSyncStatus>
        rowKey="platform"
        loading={loading}
        pagination={false}
        scroll={{ x: 980 }}
        locale={{ emptyText: "没有可展示的规则同步状态，请刷新或检查规则服务连接" }}
        dataSource={statuses}
        columns={[
          { title: "平台", dataIndex: "label", fixed: "left", width: 110 },
          {
            title: "同步状态",
            dataIndex: "state",
            width: 120,
            render: (state: RuleSyncStatus["state"]) => {
              const value = statePresentation[state];
              return <Tag color={value.color}>{value.label}</Tag>;
            },
          },
          {
            title: "版本",
            dataIndex: "latestVersion",
            width: 140,
            render: (value: string | null) => value ?? "—",
          },
          {
            title: "最后核验",
            dataIndex: "sourceCheckedAt",
            width: 190,
            render: (value: string | null) => value ? new Date(value).toLocaleString() : "—",
          },
          {
            title: "规则年龄",
            dataIndex: "ageHours",
            width: 120,
            render: (value: number | null) => value === null ? "—" : `${value.toFixed(1)} 小时`,
          },
          { title: "门禁原因", dataIndex: "reason", width: 320 },
          {
            title: "官方来源",
            dataIndex: "officialUrl",
            width: 120,
            render: (value: string) => (
              <Typography.Link href={value} target="_blank" rel="noreferrer">
                查看来源
              </Typography.Link>
            ),
          },
        ]}
      />
      </Card>
    </section>
  );
}
