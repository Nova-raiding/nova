import { Alert, Button, Form, Input, InputNumber, Select } from "antd";
import { commercialBenefitOptions } from "./benefitLabels.js";
export interface BenefitEditorValue { code: string; value: number | string; unit: string; policyRef?: string; boundVersionId?: string; }
export function encodeBenefits(values: BenefitEditorValue[] = [], previous: Array<Record<string, unknown>> = []) {
  if (new Set(values.map(value => value.code)).size !== values.length) throw new Error("同一权益不可重复配置");
  if (values.some(value => !Number.isSafeInteger(Number(value.value)) || Number(value.value) < 0)) throw new Error("权益数量必须为非负整数，使用服务端规范单位");
  if (values.some(value => value.code === "cloud_storage" && value.unit !== "byte")) throw new Error("共享存储须以已核实的规范字节数配置，不能把GB数值直接当字节");
  if (values.some(value => value.code.startsWith("feature.") && ![0, 1].includes(Number(value.value)))) throw new Error("功能权限只允许未授权0或授权1");
  return values.map(value => ({ code: value.code, quantity: Number(value.value), rawValue: null, rawUnit: value.unit || null, normalizedValue: value.code === "cloud_storage" ? Number(value.value) : null, policyRef: value.policyRef || null, metadata: previous.find(item => item.code === value.code)?.metadata ?? {} }));
}
export function RegisteredBenefitFields({ definitions, error }: { definitions: Record<string, unknown>[]; error?: string }) {
  const form = Form.useFormInstance();
  const isBound = (index: number) => Boolean(form.getFieldValue(["benefits", index, "boundVersionId"]));
  const options = definitions.filter(item => typeof item.code === "string" && typeof item.consumer === "string").map(item => ({ value: String(item.code), label: commercialBenefitOptions.find(option => option.code === item.code)?.label ?? String(item.name ?? item.code) }));
  return <><Alert type={error ? "error" : "info"} title={error ? "权益定义读取失败" : "仅支持已注册权益"} description={error ?? "功能与额度由服务端消费器决定；不允许输入新功能字符串。存储按字节输入。政策未批准或消费者缺失时不能发布。"} />
    <Form.List name="benefits">{(fields, { add, remove }) => <>{fields.map(field => <div className="commercial-catalog-benefit-row" key={field.key}>
      <Form.Item name={[field.name, "code"]} label={`权益 ${field.name + 1}`} rules={[{ required: true }]}><Select disabled={!options.length || isBound(field.name)} options={options} onChange={code => form.setFieldValue(["benefits", field.name, "unit"], definitions.find(item => item.code === code)?.unit ?? "")} /></Form.Item>
      <Form.Item noStyle shouldUpdate={(previous, next) => previous.benefits?.[field.name]?.code !== next.benefits?.[field.name]?.code}>{({ getFieldValue }) => <Form.Item name={[field.name, "value"]} label="数量或功能授权" rules={[{ required: true }]}>{String(getFieldValue(["benefits", field.name, "code"]) ?? "").startsWith("feature.") ? <Select disabled={isBound(field.name)} options={[{ value: 0, label: "不授予功能（0）" }, { value: 1, label: "授予功能（1）" }]} /> : <InputNumber disabled={isBound(field.name)} min={0} precision={0} style={{ width: "100%" }} />}</Form.Item>}</Form.Item>
      <Form.Item name={[field.name, "unit"]} label="规范单位"><Input readOnly /></Form.Item>
      <Form.Item name={[field.name, "policyRef"]} label="批准政策引用" extra="缺失时只保存草稿"><Input disabled={isBound(field.name)} /></Form.Item>
      <Button danger disabled={isBound(field.name)} onClick={() => remove(field.name)} aria-label={`移除权益 ${field.name + 1}`}>移除</Button>{isBound(field.name) && <p>该权益来自批准包版本，只读；请选择新包版本变更。</p>}
    </div>)}<Button disabled={!options.length} onClick={() => add({ value: 0, unit: "" })}>添加已注册权益</Button></>}</Form.List></>;
}
