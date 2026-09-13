/** Convert the user-facing Yuan amount to the API's integer Fen contract. */
export function yuanToFen(value: number | string): number {
  const amount = typeof value === "string" ? Number(value.trim()) : value;
  if (!Number.isFinite(amount) || amount < 0) throw new Error("金额必须是非负数字");
  return Math.round(amount * 100);
}

export function fenToYuan(value: number | string): number {
  const fen = typeof value === "string" ? Number(value.trim()) : value;
  return Number.isFinite(fen) ? fen / 100 : 0;
}
