import { describe, expect, it } from "vitest";
import { accountLabel } from "./accountLabel.js";

describe("current account display", () => {
  it.each([undefined, null])("distinguishes a missing session", (session) => {
    expect(accountLabel(session)).toBe("未登录");
  });
  it.each([undefined, null, "", " \n\t "])("does not invent a login from a missing claim (%s)", (login) => {
    expect(accountLabel({ account_login: login })).toBe("账号名称未提供");
  });
  it("displays the server-confirmed login, including Unicode accounts", () => {
    expect(accountLabel({ account_login: "  运营账号@example.com  " })).toBe("运营账号@example.com");
  });
});
