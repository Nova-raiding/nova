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
  demo_test_package: "演示套餐",
  trial: "7 天试用版",
  private_trial: "私测试用版",
  "sku-trial-1999": "7 天试用版",
  onboarding_once: "正式开通服务",
  onboarding: "正式开通服务",
  "sku-onboarding-once": "正式开通服务",
  "sku-onboarding-5000": "正式开通服务",
  "sku-onboarding-20000": "正式开通服务",
  points_500: "500 创意点包",
  "sku-points-500": "500 创意点包",
  points_2000: "2,000 创意点包",
  "sku-points-2000": "2,000 创意点包",
};

function fallbackSkuLabel(skuCode: string): string {
  const normalized = skuCode.toLowerCase().trim();
  const monthlyPlan = /^sku-monthly-(\d+)$/u.exec(normalized);
  if (monthlyPlan?.[1]) {
    const price = Number.parseInt(monthlyPlan[1] ?? "", 10);
    if (price === 2000) return "基础版（2000 元/月）";
    if (price === 5000) return "成长版（5000 元/月）";
    if (price === 10000) return "定制版（10000 元/月）";
    if (Number.isFinite(price)) return `月度订阅（${price} 元）`;
  }
  const onboardingPlan = /^sku-onboarding-(\d+)$/u.exec(normalized);
  if (onboardingPlan?.[1]) return `正式开通服务（${onboardingPlan[1]} 元）`;
  const pointPlan = /^sku-point(?:s)?-(\d+)$/u.exec(normalized);
  if (pointPlan?.[1]) return `${Number.parseInt(pointPlan[1] ?? "", 10).toLocaleString()} 创意点包`;
  const trialPlan = /^sku-trial-(\d+)$/u.exec(normalized);
  if (trialPlan?.[1]) return "7 天试用版";

  return `未命名套餐（${skuCode}）`;
}

export function packageDisplayName(skuCode: string, serverName?: string | null): string {
  return (
    packageLabels[skuCode]
    ?? (serverName && serverName !== skuCode ? serverName : fallbackSkuLabel(skuCode))
  );
}

export function packageCodeLabel(skuCode: string): string {
  return packageLabels[skuCode] ? `${packageLabels[skuCode]} · ${skuCode}` : `${fallbackSkuLabel(skuCode)} · ${skuCode}`;
}
