import { useEffect } from "react";
import { Alert, Button, Form, Input, Select, Space, Tag } from "antd";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel";

export function BrandPreferencePanel({ model }: { model: OpsConsoleModel }) {
  const { brandPreference, canKnowledge, updateBrandPreference } = model;
  const [form] = Form.useForm();
  const initial = brandPreference?.preferences
    ? JSON.stringify(brandPreference.preferences, null, 2)
    : '{\n  "tone": "专业、克制、可信",\n  "preferredWords": [],\n  "forbiddenWords": []\n}';
  useEffect(() => {
    if (!brandPreference) return;
    form.setFieldsValue({
      preferencesJson: JSON.stringify(brandPreference.preferences, null, 2),
      version: brandPreference.version,
      status: brandPreference.status,
      source: brandPreference.source ?? "",
    });
  }, [brandPreference, form]);
  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      <Alert showIcon type="info" title="品牌偏好会进入后续文案、图片和视频生成上下文" description="只有 active 版本会被正式任务引用；草稿仍需运营确认。" />
      {brandPreference && <Tag color={brandPreference.status === "active" ? "green" : "orange"}>当前版本 {brandPreference.version} · {brandPreference.status} · 修订 {brandPreference.revision}</Tag>}
      <Form
        form={form}
        layout="vertical"
        disabled={!canKnowledge}
        initialValues={{ preferencesJson: initial, version: brandPreference?.version ?? "v1", status: brandPreference?.status ?? "draft", source: brandPreference?.source ?? "" }}
        onFinish={(values) => void updateBrandPreference(values)}
      >
        <Form.Item name="preferencesJson" label="品牌偏好 JSON" rules={[{ required: true, message: "请输入品牌偏好" }]}>
          <Input.TextArea rows={7} placeholder={'{"tone":"专业、克制","preferredWords":[],"forbiddenWords":[]}'} />
        </Form.Item>
        <Space wrap>
          <Form.Item name="version" label="版本" rules={[{ required: true, message: "请输入版本" }]}><Input placeholder="v1" /></Form.Item>
          <Form.Item name="status" label="状态" rules={[{ required: true }]}><Select style={{ width: 120 }} options={[{ value: "draft", label: "草稿" }, { value: "active", label: "生效" }, { value: "archived", label: "归档" }]} /></Form.Item>
          <Form.Item name="source" label="来源"><Input placeholder="访谈/审核记录/工单" /></Form.Item>
        </Space>
        <Button type="primary" htmlType="submit" disabled={!canKnowledge}>保存品牌偏好</Button>
      </Form>
    </Space>
  );
}
