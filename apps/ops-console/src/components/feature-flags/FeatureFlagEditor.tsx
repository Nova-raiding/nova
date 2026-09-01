import { Alert, Button, Checkbox, Form, Input, Modal, Select, Space, Switch, Typography } from "antd";
import { MinusCircleOutlined, PlusOutlined } from "@ant-design/icons";
import { useEffect, useMemo } from "react";
import type { FeatureFlag, FeatureFlagMutationRequest, FeatureFlagTarget, FeatureFlagValueType } from "../../../../../packages/contracts/src/ops/feature-flags.js";

interface EditorForm { key: string; environment: string; description: string; valueType: FeatureFlagValueType; valueText: string; enabled: boolean; validFrom?: string; validTo?: string; reason: string; targets: Array<{ type: FeatureFlagTarget["type"]; value: string; enabled: boolean; overrideText?: string }> }
interface Props { open: boolean; flag?: FeatureFlag; saving: boolean; defaultEnvironment?: string; environments?: readonly string[]; onCancel(): void; onSave(input: FeatureFlagMutationRequest): Promise<unknown> }

export const MANAGED_FEATURE_FLAG_ENVIRONMENTS = ["development", "staging", "production"] as const;
export const LOCAL_FEATURE_FLAG_ENVIRONMENTS = ["local_demo", ...MANAGED_FEATURE_FLAG_ENVIRONMENTS] as const;
export const featureFlagEnvironmentOptions = (environments: readonly string[]) => environments.map(value => ({
  value,
  label: value === "local_demo" ? "本地演示（local_demo）" : value,
}));

interface FeatureFlagEnvironmentSelectProps {
  environments: readonly string[];
  disabled?: boolean;
  value?: string;
  onChange?(value: string): void;
}

export function FeatureFlagEnvironmentSelect({ environments, disabled, value, onChange }: FeatureFlagEnvironmentSelectProps) {
  return <Select aria-label="功能开关环境" style={{ width: 200 }} options={featureFlagEnvironmentOptions(environments)} disabled={disabled} value={value} onChange={onChange} />;
}

export function parseFeatureFlagValue(type: FeatureFlagValueType, raw: string) {
  if (new TextEncoder().encode(raw).byteLength > 16 * 1024) throw new Error("值不能超过 16KiB");
  if (type === "boolean") { if (raw !== "true" && raw !== "false") throw new Error("布尔值只能是 true 或 false"); return raw === "true"; }
  if (type === "number") { const value = Number(raw); if (!Number.isFinite(value)) throw new Error("请输入有效数字"); return value; }
  if (type === "json") { const value = JSON.parse(raw) as unknown; if (!value || typeof value !== "object") throw new Error("JSON 值必须是对象或数组"); return value as Record<string, unknown>; }
  return raw;
}

const displayValue = (flag?: FeatureFlag) => flag ? (flag.defaultValue.type === "string" ? String(flag.defaultValue.value) : JSON.stringify(flag.defaultValue.value, null, 2)) : "false";
export const featureFlagDateTimeInput = (value?: string) => {
  if (!value) return undefined;
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

export function canonicalReadModeWarning(input: { key?: string; environment?: string; valueText?: string; targets?: Array<{ overrideText?: string }> }) {
  if (input.key?.trim() !== "canonical.product.read_mode") return undefined;
  const values = [input.valueText ?? "", ...(input.targets ?? []).map(target => target.overrideText ?? "")].map(value => value.trim());
  if (!values.includes("canonical_read")) return undefined;
  if (input.environment === "production") return "生产环境打开 canonical_read 必须先具备正式 canonical cutover evidence；服务端会在缺证据时拒绝保存。请先完成一致性、连续 shadow 和回滚演练。";
  return "这是标准商品链切读开关。开启前请确认 workspace 一致性报告中没有未处理的 legacy_only、conflict 或 blocked，并保留可回滚的审计记录。";
}

export function FeatureFlagEditor({ open, flag, saving, defaultEnvironment = "production", environments = MANAGED_FEATURE_FLAG_ENVIRONMENTS, onCancel, onSave }: Props) {
  const [form] = Form.useForm<EditorForm>();
  const valueType = Form.useWatch("valueType", form) ?? flag?.defaultValue.type ?? "boolean";
  const flagKey = Form.useWatch("key", form);
  const flagEnvironment = Form.useWatch("environment", form);
  const flagValueText = Form.useWatch("valueText", form);
  const flagTargets = Form.useWatch("targets", form);
  const canonicalWarning = canonicalReadModeWarning({ key: flagKey, environment: flagEnvironment, valueText: flagValueText, targets: flagTargets });
  const initialValues = useMemo<Partial<EditorForm>>(() => ({ key: flag?.key ?? "", environment: flag?.environment ?? defaultEnvironment, description: flag?.description ?? "", valueType: flag?.defaultValue.type ?? "boolean", valueText: displayValue(flag), enabled: flag?.enabled ?? false, validFrom: featureFlagDateTimeInput(flag?.validFrom), validTo: featureFlagDateTimeInput(flag?.validTo), reason: "", targets: flag?.targets.map(target => ({ type: target.type, value: target.value, enabled: target.enabled, overrideText: target.override ? (target.override.type === "string" ? String(target.override.value) : JSON.stringify(target.override.value)) : undefined })) ?? [] }), [defaultEnvironment, flag]);
  useEffect(() => { if (open) form.setFieldsValue(initialValues); }, [form, initialValues, open]);

  return <Modal open={open} title={flag ? `编辑 ${flag.key}` : "新建功能开关"} onCancel={onCancel} footer={null} destroyOnHidden width={720} aria-labelledby="feature-flag-editor-title">
    <Typography.Paragraph id="feature-flag-editor-title" type="secondary">仅支持布尔、字符串、数字和 16KiB 内 JSON；不执行脚本或表达式。新开关默认关闭。</Typography.Paragraph>
    {canonicalWarning && <Alert role="alert" type="warning" showIcon title="Canonical 商品链切读前置条件" description={canonicalWarning} style={{ marginBottom: 16 }} />}
    <Form form={form} layout="vertical" initialValues={initialValues} scrollToFirstError={{ focus: true }} onFinish={async values => {
      const defaultValue = { type: values.valueType, value: parseFeatureFlagValue(values.valueType, values.valueText) };
      const targets = (values.targets ?? []).map(target => ({ type: target.type, value: target.value.trim(), enabled: target.enabled, ...(target.overrideText?.trim() ? { override: { type: values.valueType, value: parseFeatureFlagValue(values.valueType, target.overrideText) } } : {}) }));
      await onSave({ id: flag?.id, key: values.key.trim(), environment: values.environment.trim(), description: values.description.trim(), defaultValue, enabled: values.enabled, targets, validFrom: values.validFrom ? new Date(values.validFrom).toISOString() : undefined, validTo: values.validTo ? new Date(values.validTo).toISOString() : undefined, expectedRevision: flag?.revision, idempotencyKey: crypto.randomUUID(), reason: values.reason.trim() });
      onCancel();
    }}>
      <Space wrap size={16} style={{ width: "100%" }} align="start">
        <Form.Item name="key" label="开关键" rules={[{ required: true }, { pattern: /^[a-z][a-z0-9_.-]{1,127}$/, message: "使用小写字母开头及字母、数字、点、横线" }]}><Input disabled={Boolean(flag)} autoComplete="off" /></Form.Item>
        <Form.Item name="environment" label="环境" rules={[{ required: true }]}><FeatureFlagEnvironmentSelect environments={environments} disabled={Boolean(flag)} /></Form.Item>
        <Form.Item name="enabled" label="总开关" valuePropName="checked"><Switch aria-label="功能总开关" /></Form.Item>
      </Space>
      <Form.Item name="description" label="用途说明" rules={[{ required: true }, { max: 500 }]}><Input.TextArea rows={2} showCount maxLength={500} /></Form.Item>
      <Space wrap size={16} align="start">
        <Form.Item name="valueType" label="值类型" rules={[{ required: true }]}><Select style={{ width: 140 }} options={["boolean", "string", "number", "json"].map(value => ({ value, label: value }))} /></Form.Item>
        <Form.Item name="valueText" label="默认值" rules={[{ required: true }, { validator: async (_, raw) => { try { parseFeatureFlagValue(valueType, raw); } catch (error) { throw new Error(error instanceof Error ? error.message : "值无效"); } } }]}><Input.TextArea rows={valueType === "json" ? 5 : 1} style={{ minWidth: 320 }} aria-describedby="flag-value-help" /></Form.Item>
      </Space>
      <Typography.Text id="flag-value-help" type="secondary">未命中定向规则时使用此值；关闭状态不会返回该值。</Typography.Text>
      <Space wrap size={16} style={{ marginTop: 16 }}>
        <Form.Item name="validFrom" label="生效时间（可选）"><Input type="datetime-local" /></Form.Item>
        <Form.Item name="validTo" label="失效时间（可选）" dependencies={["validFrom"]} rules={[({ getFieldValue }) => ({ validator: async (_, value) => { const from = getFieldValue("validFrom") as string | undefined; if (from && value && Date.parse(value) <= Date.parse(from)) throw new Error("失效时间必须晚于生效时间"); } })]}><Input type="datetime-local" /></Form.Item>
      </Space>
      <Typography.Title level={5}>定向规则</Typography.Title>
      <Form.List name="targets">{(fields, { add, remove }) => <Space orientation="vertical" style={{ width: "100%" }}>
        {fields.map(field => <Space key={field.key} wrap align="baseline">
          <Form.Item {...field} name={[field.name, "type"]} rules={[{ required: true }]}><Select aria-label={`规则 ${field.name + 1} 类型`} style={{ width: 140 }} options={["identity", "workspace", "percentage"].map(value => ({ value, label: value }))} /></Form.Item>
          <Form.Item {...field} name={[field.name, "value"]} rules={[{ required: true }]}><Input aria-label={`规则 ${field.name + 1} 目标`} placeholder="ID 或 0..10000 基点" /></Form.Item>
          <Form.Item {...field} name={[field.name, "enabled"]} valuePropName="checked"><Checkbox>启用</Checkbox></Form.Item>
          <Form.Item {...field} name={[field.name, "overrideText"]}><Input aria-label={`规则 ${field.name + 1} 覆盖值`} placeholder="覆盖值（可选）" /></Form.Item>
          <Button style={{ minHeight: 44 }} icon={<MinusCircleOutlined aria-hidden />} onClick={() => remove(field.name)} aria-label={`删除规则 ${field.name + 1}`} />
        </Space>)}
        <Button type="dashed" style={{ minHeight: 44 }} icon={<PlusOutlined aria-hidden />} onClick={() => add({ type: "workspace", value: "", enabled: true })}>添加定向规则</Button>
      </Space>}</Form.List>
      <Form.Item name="reason" label="变更原因" rules={[{ required: true, min: 3, message: "至少输入 3 个字符，原因会写入不可变审计" }, { max: 500 }]} style={{ marginTop: 16 }}><Input.TextArea rows={2} showCount maxLength={500} /></Form.Item>
      <Space><Button style={{ minHeight: 44 }} onClick={onCancel}>取消</Button><Button style={{ minHeight: 44 }} type="primary" htmlType="submit" loading={saving}>保存并记录审计</Button></Space>
    </Form>
  </Modal>;
}
