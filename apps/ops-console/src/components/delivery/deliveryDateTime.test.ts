import { describe, expect, it } from "vitest";
import { deliveryCompletionTimeLabel, deliveryDateTimeInputValue, deliveryDateTimeIsoValue } from "./deliveryDateTime.js";

describe("delivery local date and API timestamp boundary", () => {
  it("preserves the operator's local time across a UTC round-trip", () => {
    const local = "2026-10-01T09:00";
    const instant = new Date(2026, 9, 1, 9, 0).toISOString();
    expect(deliveryDateTimeIsoValue(local)).toBe(instant);
    expect(deliveryDateTimeInputValue(instant)).toBe(local);
  });
  it("handles empty input and rejects invalid dates", () => {
    expect(deliveryDateTimeInputValue()).toBe("");
    expect(deliveryDateTimeInputValue("invalid")).toBe("");
    expect(deliveryDateTimeIsoValue()).toBeUndefined();
    expect(() => deliveryDateTimeIsoValue("invalid")).toThrow("要求上线时间无效");
  });
  it("shows completion in the operator's local clock without exposing raw ISO timestamps", () => {
    expect(deliveryCompletionTimeLabel(new Date(2026, 9, 1, 9, 5).toISOString())).toBe("2026-10-01 09:05");
    expect(deliveryCompletionTimeLabel()).toBe("尚未完成");
    expect(deliveryCompletionTimeLabel("invalid")).toBe("完成时间待核验");
  });
});
