import type { CommercialCatalogItem } from "../../api/commercialOperationsClient.js";

const benefitLabels: Record<string, string> = {
  creative_points: "创意点",
  cloud_storage: "共享存储",
  max_brands: "品牌数",
  max_stores: "店铺数",
  first_response_business_hours: "首响时间",
  grant_count: "赠送批次",
  points_per_grant: "每批点数",
  monthly_one_to_one_hours: "每月一对一服务",
  one_to_one_service_hours: "一对一服务",
  outcome_review_count: "复盘次数",
};

const benefitUnits: Record<string, string> = {
  GB_DECIMAL: "GB",
  creative_points: "点",
  business_hour: "个工作小时",
  monthly_grants: "批/月",
  brand: "个品牌",
  store: "家店铺",
  hour: "小时",
  review: "次",
};

const benefitDefaultUnits: Record<string, string> = {
  creative_points: "点",
  cloud_storage: "GB",
  max_brands: "个品牌",
  max_stores: "家店铺",
  first_response_business_hours: "个工作小时",
  grant_count: "批/月",
  points_per_grant: "点",
  monthly_one_to_one_hours: "小时/月",
  one_to_one_service_hours: "小时",
  outcome_review_count: "次",
};

export const commercialBenefitDescriptions: Record<string, string> = {
  creative_points: "用于图片、文本等创意生成的点数额度",
  cloud_storage: "当前企业主体可使用的共享文件存储空间",
  max_brands: "可维护的品牌档案数量上限",
  max_stores: "可绑定并管理的店铺数量上限",
  first_response_business_hours: "服务团队首次响应时限",
  grant_count: "每月赠送的点数批次数量",
  points_per_grant: "每次赠送批次包含的创意点数",
  monthly_one_to_one_hours: "每月可使用的一对一服务时长",
  one_to_one_service_hours: "套餐内包含的一对一服务总时长",
  outcome_review_count: "包含的经营结果复盘次数",
};

export const commercialBenefitOptions = Object.entries(benefitLabels).map(([code, label]) => ({
  code,
  label,
  defaultUnit: benefitDefaultUnits[code] ?? "",
}));

const labelFor = (code: string) => benefitLabels[code] ?? `未翻译权益（${code}）`;
const unitFor = (unit: string | null) => unit ? benefitUnits[unit] ?? unit : "";

function formatPair(code: string, rawValue: string, rawUnit: string | null): string {
  const [rawQuantity, ...rest] = rawValue.trim().split(/\s+/u);
  const quantity = rawQuantity && /^-?\d+(?:\.\d+)?$/u.test(rawQuantity) ? rawQuantity : null;
  const suffix = rest.join(" ");
  const value = quantity
    ? `${quantity}${unitFor(rawUnit) ? ` ${unitFor(rawUnit)}` : suffix ? ` ${unitFor(suffix)}` : ""}`
    : rawValue;
  return `${labelFor(code)}：${value}`;
}

/** Converts persisted benefit keys such as creative_points:5000 点/月 into operator-facing Chinese. */
export function readableBenefits(item: CommercialCatalogItem): string {
  if (item.benefits?.length) {
    return item.benefits.map((benefit) => {
      const value = benefit.quantity !== null
        ? `${benefit.quantity}${unitFor(benefit.rawUnit) ? ` ${unitFor(benefit.rawUnit)}` : ""}`
        : benefit.rawValue ? formatPair(benefit.code, benefit.rawValue, benefit.rawUnit) : "按合同";
      return benefit.rawValue && benefit.quantity === null ? value : `${labelFor(benefit.code)}：${value}`;
    }).join(" · ");
  }

  const summary = item.benefitsSummary?.trim();
  if (!summary) return "未配置可读权益";
  return summary.split(/[;；]+/u).map((part) => {
    const match = part.trim().match(/^([^:：]+)[:：](.+)$/u);
    return match ? formatPair(match[1].trim(), match[2].trim(), null) : part.trim();
  }).filter(Boolean).join(" · ");
}

/** Individual operator-facing lines for tables and detail drawers. */
export function readableBenefitItems(item: CommercialCatalogItem): string[] {
  return readableBenefits(item).split(" · ").map((value) => value.trim()).filter(Boolean);
}
