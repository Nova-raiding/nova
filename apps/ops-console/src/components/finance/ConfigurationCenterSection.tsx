import {
  Button,
  Card,
  Col,
  Alert,
  Form,
  Input,
  InputNumber,
  Row,
  Switch,
  Table,
  Tabs,
  Tag,
  Space,
} from "antd";
import { SaveOutlined } from "@ant-design/icons";
import { useEffect, useRef } from "react";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import type { Platform, PlatformSetting } from "../../types/ops";

interface ConfigurationCenterSectionProps {
  model: OpsConsoleModel;
}

export function ConfigurationCenterSection({
  model,
}: ConfigurationCenterSectionProps) {
  const {
    settings,
    platformRows,
    setPlatformRows,
    platformOperations,
    orders,
    loading,
    saving,
    canPlatformOps,
    saveCommercial,
    savePlatform,
    dataSetError,
  } = model;
  const configurationError = dataSetError("workspace.commercial.get");
  const configurationErrorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (configurationError) {
      configurationErrorRef.current?.focus({ preventScroll: true });
    }
  }, [configurationError]);

  return (
    <Card
      loading={loading}
      title="配置中心"
      extra={<Tag color="blue">Revision {settings?.revision ?? "-"}</Tag>}
    >
      {configurationError ? (
        <div ref={configurationErrorRef} tabIndex={-1} role="alert" aria-label="配置中心错误摘要" style={{ marginBottom: 16 }}>
          <Alert
            type="error"
            showIcon
            title="配置中心读取失败"
            description={configurationError}
            action={<Button htmlType="button" onClick={() => void model.load()} aria-label="刷新配置中心" style={{ minHeight: 44 }}>刷新配置</Button>}
          />
        </div>
      ) : null}
      <Tabs
        items={[
          {
            key: "commercial",
            forceRender: true,
            label: "套餐与额度",
            children: (
              <Form
                key={settings?.revision}
                initialValues={settings}
                layout="vertical"
                onFinish={saveCommercial}
                className="config-form"
                disabled={!canPlatformOps || !settings}
              >
                <Row gutter={16}>
                  <Col xs={24} md={8}>
                    <Form.Item
                      name="planCode"
                      label="套餐编码"
                      rules={[{ required: true }]}
                    >
                      <Input />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={8}>
                    <Form.Item
                      name="planName"
                      label="套餐名称"
                      rules={[{ required: true }]}
                    >
                      <Input />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={8}>
                    <Form.Item
                      name="includedStores"
                      label="店铺额度"
                      rules={[{ required: true, type: "number", min: 0 }]}
                    >
                      <InputNumber min={0} className="full-width" />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={8}>
                    <Form.Item
                      name="monthlyPriceCny"
                      label="月价（元）"
                      rules={[{ required: true, type: "number", min: 0 }]}
                    >
                      <InputNumber
                        min={0}
                        precision={2}
                        className="full-width"
                      />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={8}>
                    <Form.Item
                      name="annualPriceCny"
                      label="年价（元）"
                      rules={[{ required: true, type: "number", min: 0 }]}
                    >
                      <InputNumber
                        min={0}
                        precision={2}
                        className="full-width"
                      />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={8}>
                    <Form.Item
                      name="includedTasks"
                      label="月度任务额度"
                      rules={[{ required: true, type: "number", min: 0 }]}
                    >
                      <InputNumber min={0} className="full-width" />
                    </Form.Item>
                  </Col>
                </Row>
                <Button
                  disabled={!canPlatformOps || !settings}
                  type="primary"
                  htmlType="submit"
                  icon={<SaveOutlined />}
                  loading={saving}
                >
                  保存商业配置
                </Button>
              </Form>
            ),
          },
          {
            key: "platforms",
            forceRender: true,
            label: "平台与店铺",
            children: (
              <>
                <Alert
                  type="info"
                  showIcon
                  title="此处不是 OAuth 授权配置"
                  description="这里仅维护平台在运营后台的展示名称、店铺别名和启用状态。平台 AppKey/Secret、OAuth 回调、Vault 凭据及真实 API 能力由部署环境配置；商家店铺授权请在“平台连接”中发起，真实状态以平台上线 readiness 和授权审计为准。未配置或未验证时系统会保持只读并阻断发布。"
                  style={{ marginBottom: 16 }}
                />
                <Alert
                  type={platformOperations.length ? "success" : "warning"}
                  showIcon
                  title={platformOperations.length ? "授权与能力状态已从运行态读取" : "尚未取得运行态授权状态"}
                  description={platformOperations.length
                    ? "下表的授权/读写状态来自 API 运行态检查；展示名称、别名和启用开关不会改变 OAuth 凭据或平台 API 能力。"
                    : "当前无法把空数据解释为已授权。请刷新运行态数据，并检查 API、数据库和运营会话。"}
                  style={{ marginBottom: 16 }}
                />
                <Table
                  rowKey="platform"
                  pagination={false}
                  dataSource={platformRows}
                  columns={[
                  {
                    title: "平台",
                    dataIndex: "platform",
                    render: (value: Platform) => (
                      <Tag>{value.toUpperCase()}</Tag>
                    ),
                  },
                  {
                    title: "展示名称",
                    dataIndex: "displayName",
                    render: (_: string, row: PlatformSetting) => (
                      <Input
                        disabled={!canPlatformOps}
                        aria-label={`${row.platform} 展示名称`}
                        value={row.displayName}
                        onChange={(event) =>
                          setPlatformRows((current) =>
                            current.map((item) =>
                              item.platform === row.platform
                                ? {
                                    ...item,
                                    displayName: event.target.value,
                                  }
                                : item,
                            ),
                          )
                        }
                      />
                    ),
                  },
                  {
                    title: "店铺别名",
                    dataIndex: "storeAlias",
                    render: (_: string, row: PlatformSetting) => (
                      <Input
                        disabled={!canPlatformOps}
                        aria-label={`${row.platform} 店铺别名`}
                        value={row.storeAlias}
                        onChange={(event) =>
                          setPlatformRows((current) =>
                            current.map((item) =>
                              item.platform === row.platform
                                ? {
                                    ...item,
                                    storeAlias: event.target.value,
                                  }
                                : item,
                            ),
                          )
                        }
                      />
                    ),
                  },
                  {
                    title: "授权与能力",
                    key: "runtime-status",
                    render: (_: unknown, row: PlatformSetting) => {
                      const runtime = platformOperations.find((item) => item.platform === row.platform);
                      const simulated = runtime?.simulated === true || runtime?.dataMode === "fixture";
                      const connected = runtime?.state === "connected" || (runtime?.connectedAccountCount ?? 0) > 0;
                      const status = simulated
                        ? { color: "gold" as const, label: "演示连接" }
                        : connected && runtime?.writeEnabled
                          ? { color: "green" as const, label: "已授权·可写" }
                          : connected && runtime?.readEnabled
                            ? { color: "blue" as const, label: "已授权·只读" }
                            : connected
                              ? { color: "orange" as const, label: "已授权·能力未就绪" }
                              : { color: "default" as const, label: "未授权/未配置" };
                      const reason = runtime?.readiness?.reasons?.join("、") || (runtime?.readiness?.mediaUpload?.reason ?? "");
                      return (
                        <Space orientation="vertical" size={0}>
                          <Tag color={status.color}>{status.label}</Tag>
                          <span style={{ color: "#667085", fontSize: 12 }}>
                            {runtime ? `${runtime.connectedAccountCount ?? 0}/${runtime.accountCount ?? 0} 个店铺` : "运行态不可用"}
                          </span>
                          {reason ? <span title={reason} style={{ color: "#98A2B3", fontSize: 11, maxWidth: 190 }}>{reason}</span> : null}
                        </Space>
                      );
                    },
                  },
                  {
                    title: "变更原因",
                    render: (_: unknown, row: PlatformSetting) => (
                      <Input
                        disabled={!canPlatformOps}
                        aria-label={`${row.platform} 变更原因`}
                        placeholder="必填，写入审计"
                        value={row.changeReason}
                        onChange={(event) =>
                          setPlatformRows((current) =>
                            current.map((item) =>
                              item.platform === row.platform
                                ? {
                                    ...item,
                                    changeReason: event.target.value,
                                  }
                                : item,
                            ),
                          )
                        }
                      />
                    ),
                  },
                  {
                    title: "启用",
                    dataIndex: "enabled",
                    render: (_: boolean, row: PlatformSetting) => (
                      <Switch
                        disabled={!canPlatformOps}
                        checked={row.enabled}
                        onChange={(checked) =>
                          setPlatformRows((current) =>
                            current.map((item) =>
                              item.platform === row.platform
                                ? { ...item, enabled: checked }
                                : item,
                            ),
                          )
                        }
                      />
                    ),
                  },
                  {
                    title: "操作",
                    render: (_: unknown, row: PlatformSetting) => (
                      <Button
                        disabled={!canPlatformOps}
                        type="link"
                        onClick={() => void savePlatform(row)}
                      >
                        保存
                      </Button>
                    ),
                  },
                  ]}
                />
              </>
            ),
          },
          {
            key: "orders",
            forceRender: true,
            label: "订阅订单",
            children: (
              <Table
                rowKey="id"
                pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => `共 ${total} 条` }}
                dataSource={orders}
                columns={[
                  { title: "订单号", dataIndex: "orderNo" },
                  { title: "套餐", dataIndex: "planName" },
                  { title: "周期", dataIndex: "billingCycle" },
                  {
                    title: "金额",
                    dataIndex: "priceCny",
                    render: (value: number) => `¥${value.toFixed(2)}`,
                  },
                  { title: "状态", dataIndex: "status" },
                  {
                    title: "创建时间",
                    dataIndex: "createdAt",
                    render: (value: string) => new Date(value).toLocaleString(),
                  },
                ]}
              />
            ),
          },
        ]}
      />
    </Card>
  );
}
