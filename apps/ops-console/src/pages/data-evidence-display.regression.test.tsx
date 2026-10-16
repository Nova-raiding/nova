import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("antd", async importOriginal => {
  const actual = await importOriginal<typeof import("antd")>();
  return { ...actual, Drawer: ({ children }: { children: React.ReactNode }) => createElement("section", null, children) };
});
import { ModelStatusSection } from "../components/models/ModelStatusSection";
import { ModelChannelMatrix } from "../components/models/ModelChannelMatrix";
import { FinanceDetailDrawer } from "../components/finance/FinanceDetailDrawer";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";
import type { ModelStatus } from "../types/ops";
import type { FinanceRecordDetail } from "../../../../packages/contracts/src/ops/finance-search";
const status = {
  state: "ready", ownership: "platform", user_key_binding: false,
  capabilities: { text_generation: true, image_generation: true, image_editing: true, image_fact_ocr: true, video_rendering: true },
  model_readiness: Object.fromEntries(["text", "image", "image_edit", "ocr", "video"].map(key => [key, {ready:true,provider_configured:true,reasons:[]}])),
  cost_evidence_by_modality: {text:true,image:true,image_edit:true,ocr:true,video:true},
  cost_control_ready: true, cost_evidence_ready:true, release_metadata_ready:true,
  quotas: {rpm:100,tpm:1000,daily_cny_limit:"100"}, relay:{configured:true,host:"unverified-relay.test"},
  text_model:"unverified-text-model", next_actions:[],
} as unknown as ModelStatus;
const detail: FinanceRecordDetail = {
 id:"record-old",kind:"model_usage",workspaceId:"workspace-old",status:"settled",label:"模型用量",amountCny:973.21,
 occurredAt:"2026-10-15T00:00:00Z",updatedAt:"2026-10-15T00:00:00Z",version:"1",redacted:true,attributes:{},
};
describe("display only current verified evidence", () => {
 it("never shows fixture model status as passed capabilities or costs", () => {
  const model = {modelStatus:status,modelStatusLoading:false,dataSource:{fixtureDataPresent:true,environment:"demo"},dataSetError:()=>undefined,load:async()=>{}} as unknown as OpsConsoleModel;
  const html=renderToStaticMarkup(<ModelStatusSection model={model}/>);
  expect(html).not.toContain("门禁通过</span>");
  expect(html).not.toContain("成本与计费组：已就绪");
  expect(html).not.toContain("unverified-text-model");
 });
 it("never promotes fixture channel cost evidence to a successful summary", () => {
  const html=renderToStaticMarkup(<ModelChannelMatrix status={status} fixtureDataPresent/>);
  expect(html).not.toContain("ant-alert-success");
  expect(html).not.toContain("配置门禁通过</span>");
 });
 it("hides cached financial amounts after a detail read fails", () => {
  const html=renderToStaticMarkup(<FinanceDetailDrawer selected={detail} detail={detail} loading={false} error="本次详情读取失败" onRetry={()=>{}} onClose={()=>{}}/>);
  expect(html).toContain("本次详情读取失败");
  expect(html).not.toContain("973.21");
 });
 it("never shows a prior record when selection changes before detail arrives", () => {
  const html=renderToStaticMarkup(<FinanceDetailDrawer selected={{...detail,id:"record-new",workspaceId:"workspace-new"}} detail={detail} loading={false} onRetry={()=>{}} onClose={()=>{}}/>);
  expect(html).not.toContain("973.21");
  expect(html).not.toContain("record-old");
 });
});
