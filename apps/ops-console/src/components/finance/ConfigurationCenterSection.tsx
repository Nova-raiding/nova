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
            ),
          },
          {
            key: "orders",
            forceRender: true,
            label: "订阅订单",
            children: (
              <Table
                rowKey="id"
                pagination={{ pageSize: 8 }}
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
