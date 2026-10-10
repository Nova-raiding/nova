import { describe, expect, it } from "vitest";
import { supportActionFeedbackOnOpen } from "./SupportTicketDetailSection.js";

describe("support action dialog feedback", () => {
  it("clears prior operation errors when a different action dialog opens", () => {
    expect(supportActionFeedbackOnOpen("上次分配负责人失败", false)).toEqual({ error: "", dismissed: false });
    expect(supportActionFeedbackOnOpen("上次备注失败", true)).toEqual({ error: "", dismissed: false });
  });
});
