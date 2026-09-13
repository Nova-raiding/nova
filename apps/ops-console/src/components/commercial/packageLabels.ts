const packageLabels: Record<string, string> = {
  basic: "基础版",
  monthly_basic: "基础版",
  "sku-monthly-2000": "基础版",
  growth: "成长版",
  monthly_growth: "成长版",
  "sku-monthly-5000": "成长版",
  custom: "定制版",
  monthly_custom: "定制版",
  "sku-monthly-10000": "定制版",
  trial: "7 天试用版",
  private_trial: "私测试用版",
  "sku-trial-1999": "7 天试用版",
  onboarding_once: "正式开通服务",
  onboarding: "正式开通服务",
  "sku-onboarding-once": "正式开通服务",
  "sku-onboarding-5000": "正式开通服务",
  points_500: "500 创意点包",
  "sku-points-500": "500 创意点包",
  points_2000: "2,000 创意点包",
  "sku-points-2000": "2,000 创意点包",
};

export function packageDisplayName(skuCode: string, serverName?: string | null): string {
  return packageLabels[skuCode] ?? (serverName && serverName !== skuCode ? serverName : `未命名套餐（${skuCode}）`);
}

export function packageCodeLabel(skuCode: string): string {
  return packageLabels[skuCode] ? `${packageLabels[skuCode]} · ${skuCode}` : skuCode;
}
