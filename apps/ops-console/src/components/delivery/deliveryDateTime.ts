/** datetime-local uses the operator's local clock; API timestamps use UTC. */
export function deliveryDateTimeInputValue(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function deliveryDateTimeIsoValue(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("要求上线时间无效，请重新选择");
  return date.toISOString();
}
