import { rpcForWorkspace } from "./opsClient.js";

export interface ManualProductImportInput {
  workspaceId: string;
  platform: string;
  accountId: string;
  products: Record<string, unknown>[];
  sourceRef: string;
  sourceSha256: string;
  reason: string;
  mismatchedCount: number;
  confirmationCount: number;
  assignmentConfirmed: boolean;
  containsAssetRefs: boolean;
}

export async function importManualProducts(input: ManualProductImportInput) {
  const { workspaceId, platform, accountId, products } = input;
  if (!workspaceId.trim() || !platform.trim() || !accountId.trim()) throw new Error("必须明确选择商家工作区和人工登记店铺");
  if (!products.length || products.length > 50) throw new Error("一次只能导入 1 至 50 个商品");
  if (input.mismatchedCount > 0) throw new Error("商品归属与所选店铺不一致，已阻止导入");
  if (input.containsAssetRefs) throw new Error("运营代传表格暂不支持素材 ID");
  if (input.confirmationCount > 0 && !input.assignmentConfirmed) throw new Error("请先确认商品归属属于所选店铺");
  if (!input.sourceRef.trim() || input.sourceRef.trim().length > 1000) throw new Error("资料来源必须为 1 至 1000 个字符");
  if (!/^[0-9a-f]{64}$/iu.test(input.sourceSha256)) throw new Error("商品来源文件 SHA-256 无效");
  if (!input.reason.trim() || input.reason.trim().length > 1000) throw new Error("操作原因必须为 1 至 1000 个字符");
  const productsJson = JSON.stringify(products);
  if (productsJson.length > 33_000) throw new Error("商品数据超过单次导入大小，请拆分表格");

  const response = await rpcForWorkspace<{ result?: { count?: number; products?: Array<{ id: string }> } }>(workspaceId, "ops.platform.product.import.batch", {
    workspace_id: workspaceId,
    platform,
    account_id: accountId,
    products_json: productsJson,
    source_ref: input.sourceRef.trim(),
    source_sha256: input.sourceSha256,
    ...(input.confirmationCount > 0 ? { store_assignment_confirmed: "true" } : {}),
    reason: input.reason.trim(),
  }, { timeoutMs: 120_000 });
  if (response?.result?.count !== products.length || response.result.products?.length !== products.length
    || response.result.products.some(product => !product || typeof product.id !== "string" || !product.id.trim())) {
    throw new Error("服务端未确认完整导入，请先查询商品记录，不要重复提交");
  }
  return response.result;
}
