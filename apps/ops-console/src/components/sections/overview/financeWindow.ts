/** Return the current Asia/Shanghai calendar month as an ISO query window. */
export function shanghaiMonthWindow(now: Date = new Date()): { from_at: string; to_at: string; label: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month || !Number.isFinite(now.getTime())) throw new RangeError("A valid date is required");
  return {
    from_at: `${year}-${month}-01T00:00:00+08:00`,
    to_at: now.toISOString(),
    label: `${year}年${Number(month)}月`,
  };
}

/** One authoritative month snapshot for both the displayed heading and query. */
export function platformMonthlyFinanceRequest(now: Date = new Date()) {
  const { from_at, to_at, label } = shanghaiMonthWindow(now);
  return {
    label,
    params: {
      kinds_json: JSON.stringify(["recharge_order", "subscription_order"]),
      statuses_json: JSON.stringify(["paid"]),
      from_at,
      to_at,
      limit: "1",
    },
  };
}

/** Compact month label used by the desktop overview design. */
export function dashboardMonthLabel(label?: string, now: Date = new Date()): string {
  const source = label ?? shanghaiMonthWindow(now).label;
  const month = source.match(/年(\d{1,2}月)$/u)?.[1];
  return month ?? source;
}

/** Match the overview's compact currency style without changing numeric values. */
export function formatOverviewCurrency(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
