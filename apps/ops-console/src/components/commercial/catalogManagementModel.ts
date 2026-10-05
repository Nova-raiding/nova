import { fenToYuan } from "../../utils/currency.js";
import type { CommercialBenefitBundle, CommercialCatalogItem, CommercialPage, CommercialPageRequest } from "../../api/commercialOperationsClient.js";

export async function loadAllBenefitBundlePages(
  loadPage: (input: CommercialPageRequest, signal?: AbortSignal) => Promise<CommercialPage<CommercialBenefitBundle>>,
  signal?: AbortSignal,
): Promise<CommercialBenefitBundle[]> {
  const bundles = new Map<string, CommercialBenefitBundle>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = await loadPage({ limit: 100, ...(cursor ? { cursor } : {}) }, signal);
    for (const bundle of page.items) bundles.set(`${bundle.code}\u0000${bundle.versionId}`, bundle);
    if (!page.nextCursor) return [...bundles.values()];
    if (seenCursors.has(page.nextCursor)) throw new Error("权益包目录分页游标重复，已停止读取以避免不完整绑定");
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error("权益包目录超过100页读取上限；当前目录不完整，不能进行套餐绑定");
}

export function mergeBenefitBundleVersions(existing: readonly CommercialBenefitBundle[], incoming: readonly CommercialBenefitBundle[]): CommercialBenefitBundle[] {
  const bundles = new Map<string, CommercialBenefitBundle>();
  for (const bundle of [...existing, ...incoming]) bundles.set(`${bundle.code}\u0000${bundle.versionId}`, bundle);
  return [...bundles.values()];
}

export interface CatalogProductRow {
  code: string;
  versions: CommercialCatalogItem[];
  latest: CommercialCatalogItem;
  current?: CommercialCatalogItem;
  saleState: string;
  saleRevision: number | null;
}

/** Only the server's sale projection establishes the currently sold contract. */
export function catalogProductRows(items: readonly CommercialCatalogItem[]): CatalogProductRow[] {
  const groups = new Map<string, CommercialCatalogItem[]>();
  for (const item of items) groups.set(item.skuCode, [...(groups.get(item.skuCode) ?? []), item]);
  return [...groups].map(([code, versions]) => {
    versions.sort((a, b) => Number.parseInt(b.version.replace(/^v/u, ""), 10) - Number.parseInt(a.version.replace(/^v/u, ""), 10));
    const latest = versions[0]!;
    const projections = versions.filter(item => typeof item.saleRevision === "number");
    projections.sort((a, b) => (b.saleRevision ?? -1) - (a.saleRevision ?? -1));
    const projection = projections[0];
    const candidates = projection?.currentSaleState === "on_sale" ? versions.filter(item => item.id === projection.currentSaleVersionId && item.approvalState === "approved") : [];
    return { code, versions, latest, current: candidates.length === 1 ? candidates[0] : undefined, saleState: projection?.currentSaleState === "on_sale" && candidates.length !== 1 ? "unknown" : projection?.currentSaleState ?? "unknown", saleRevision: projection?.saleRevision ?? null };
  }).sort((a, b) => a.code.localeCompare(b.code));
}

export const saleStateLabels: Record<string, string> = { unlisted: "未上架", on_sale: "在售", off_sale: "已下架", archived: "已归档", deleted: "草稿已删除", unknown: "销售状态未确认" };
export const approvalLabels: Record<string, string> = { draft: "草稿", pending_business_approval: "待审批", approved: "已批准", rejected: "已拒绝", retired: "历史停售" };

export function catalogPriceYuan(item: Pick<CommercialCatalogItem, "priceFen" | "priceLabel">): number {
  if (typeof item.priceFen === "number" && Number.isFinite(item.priceFen) && item.priceFen >= 0) return fenToYuan(item.priceFen);
  const normalized = item.priceLabel.replace(/[,_\s]/gu, "");
  const matched = normalized.match(/\d+(?:\.\d+)?/u)?.[0];
  return matched ? Number(matched) : 0;
}
