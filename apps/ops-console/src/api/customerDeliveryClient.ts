import { rpc } from "./opsClient.js";
import type { CustomerDeliveryRecord } from "../components/delivery/CustomerDeliverySection.js";

export interface CustomerDeliveryClient {
  list(signal?: AbortSignal): Promise<CustomerDeliveryRecord[] | null>;
  updateChecklist(input: {
    deliveryId: string;
    checklistKey: "system_integration" | "functional_acceptance";
    items: Array<{ itemKey: string; completed: boolean; evidence: string }>;
    expectedRevision: number;
  }, signal?: AbortSignal): Promise<unknown>;
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const bool = (value: unknown): value is boolean => typeof value === "boolean";

/** Parse the server's snake_case aggregate without allowing malformed data to
 * silently appear as an empty customer list. */
export function parseCustomerDeliveryList(value: unknown): CustomerDeliveryRecord[] {
  const rows = Array.isArray(value) ? value : object(value) && Array.isArray(value.items) ? value.items : null;
  if (!rows) throw new Error("客户交付接口返回了无效响应（items）");
  return rows.map((row, index) => {
    if (!object(row) || !text(row.id) || !text(row.companyName ?? row.company_name)) throw new Error(`客户交付接口返回了无效响应（第 ${index + 1} 条）`);
    const status = row.paymentStatus ?? row.payment_status;
    if (status !== "paid" && status !== "unpaid") throw new Error(`客户交付接口返回了无效响应（付款状态，第 ${index + 1} 条）`);
    const profile = row.profile ?? row.customerProfileStatus === "complete";
    const integration = row.integration ?? row.systemIntegrationStatus === "complete";
    const acceptance = row.acceptance ?? row.functionalAcceptanceStatus === "complete";
    const training = row.training ?? row.trainingCompleted;
    if (![profile, integration, acceptance, training].every(bool)) throw new Error(`客户交付接口返回了无效响应（清单状态，第 ${index + 1} 条）`);
    const videos = Array.isArray(row.videos) ? row.videos.length : typeof row.videos === "number" ? row.videos : Array.isArray(row.videoUrls) ? row.videoUrls.length : 0;
    return {
      id: row.id,
      companyName: (row.companyName ?? row.company_name) as string,
      paymentStatus: status,
      profile: profile as boolean, integration: integration as boolean, acceptance: acceptance as boolean, training: training as boolean, videos,
      ...(text(row.contractNo ?? row.contractNumber ?? row.contract_number) ? { contractNo: (row.contractNo ?? row.contractNumber ?? row.contract_number) as string } : {}),
      ...(text(row.owner ?? row.projectOwner ?? row.project_owner) ? { owner: (row.owner ?? row.projectOwner ?? row.project_owner) as string } : {}),
      ...(text(row.afterSalesOwner ?? row.supportOwner ?? row.support_owner) ? { afterSalesOwner: (row.afterSalesOwner ?? row.supportOwner ?? row.support_owner) as string } : {}),
      ...(text(row.paymentDate ?? row.payment_date) ? { paymentDate: (row.paymentDate ?? row.payment_date) as string } : {}),
      ...(text(row.requiredLaunchAt ?? row.plannedGoLiveAt ?? row.planned_go_live_at) ? { requiredLaunchAt: (row.requiredLaunchAt ?? row.plannedGoLiveAt ?? row.planned_go_live_at) as string } : {}),
      ...(text(row.contractFile ?? row.contractRef ?? row.contract_ref) ? { contractFile: (row.contractFile ?? row.contractRef ?? row.contract_ref) as string } : {}),
      ...(text(row.effectiveAt ?? row.effective_at) ? { goLiveAt: (row.effectiveAt ?? row.effective_at) as string } : {}),
      ...(Array.isArray(row.videoUrls) ? { videoUrls: row.videoUrls.filter(text) } : {}),
      ...(typeof row.revision === "number" ? { revision: row.revision } : {}),
    };
  });
}

export const customerDeliveryClient: CustomerDeliveryClient = {
  async list(signal) {
    const value = await rpc<unknown>("ops.customer-delivery.list", {}, { signal });
    return value === null ? null : parseCustomerDeliveryList(value);
  },
  async updateChecklist(input, signal) {
    return rpc("ops.customer-delivery.checklist.update", {
      delivery_id: input.deliveryId,
      checklist_key: input.checklistKey,
      items_json: JSON.stringify(input.items),
      // Keep the aggregate flag for backwards-compatible servers. The server
      // must still validate and persist each item from items_json.
      completed: String(input.items.length > 0 && input.items.every((item) => item.completed)),
      expected_revision: String(input.expectedRevision),
    }, { signal });
  },
};
