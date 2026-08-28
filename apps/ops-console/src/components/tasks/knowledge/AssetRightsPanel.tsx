import { Button, Form, Input, Select, Space, Table, Tag } from "antd";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel";
import type { KnowledgeAsset } from "../../../types/ops";

interface AssetRightsPanelProps {
  model: OpsConsoleModel;
}

export function AssetRightsPanel({ model }: AssetRightsPanelProps) {
  const {
    canKnowledge,
    createKnowledgeAsset,
    knowledgeAssetForm,
    knowledgeAssets,
    updateKnowledgeAsset,
  } = model;

  return (
    <>
      <Form
        form={knowledgeAssetForm}
        layout="inline"
        onFinish={createKnowledgeAsset}
        disabled={!canKnowledge}
        style={{ marginBottom: 16 }}
      >
        <Form.Item
          name="kind"
          initialValue="brand"
          rules={[{ required: true }]}
        >
          <Select
            style={{ width: 120 }}
            options={[
              { value: "brand", label: "品牌资产" },
              { value: "customer", label: "客户资产" },
            ]}
          />
        </Form.Item>
        <Form.Item name="name" rules={[{ required: true }]}>
          <Input placeholder="资产名称" />
        </Form.Item>
        <Form.Item name="contentJson" rules={[{ required: true }]}>
          <Input placeholder="内容 JSON" />
        </Form.Item>
        <Form.Item name="source">
          <Input placeholder="来源" />
        </Form.Item>
        <Button disabled={!canKnowledge} type="primary" htmlType="submit">
          录入资产
        </Button>
      </Form>
      <Table
        rowKey="id"
        pagination={{ pageSize: 6 }}
        dataSource={knowledgeAssets}
        columns={[
          { title: "名称", dataIndex: "name" },
          { title: "类型", dataIndex: "kind" },
          {
            title: "确认状态",
            render: (_: unknown, row: KnowledgeAsset) => (
              <Tag
                color={row.approvalStatus === "approved" ? "green" : "orange"}
              >
                {row.approvalStatus}
              </Tag>
            ),
          },
          {
            title: "权益",
            render: (_: unknown, row: KnowledgeAsset) => (
              <Tag
                color={
                  row.rightsStatus === "cleared"
                    ? "green"
                    : row.rightsStatus === "restricted"
                      ? "red"
                      : "orange"
                }
              >
                {row.rightsStatus}
              </Tag>
            ),
          },
          {
            title: "来源",
            dataIndex: "source",
            render: (value: string | undefined) => value || "-",
          },
          {
            title: "操作",
            render: (_: unknown, row: KnowledgeAsset) => (
              <Space>
                <Button
                  disabled={!canKnowledge}
                  type="link"
                  onClick={() =>
                    void updateKnowledgeAsset(row, {
                      approvalStatus: "approved",
                    })
                  }
                >
                  批准
                </Button>
                <Button
                  disabled={!canKnowledge}
                  type="link"
                  danger
                  onClick={() =>
                    void updateKnowledgeAsset(row, {
                      approvalStatus: "rejected",
                    })
                  }
                >
                  驳回
                </Button>
                <Button
                  disabled={!canKnowledge}
                  type="link"
                  onClick={() =>
                    void updateKnowledgeAsset(row, { rightsStatus: "cleared" })
                  }
                >
                  确认权益
                </Button>
              </Space>
            ),
          },
        ]}
      />
    </>
  );
}
