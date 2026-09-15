import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CustomerDeliveryAccountBinding, mergeCustomerDeliveryAccounts } from "./CustomerDeliveryAccountBinding.js";
import type { CustomerDeliveryRecord } from "./CustomerDeliverySection.js";

const record: CustomerDeliveryRecord = { id: "delivery-1", companyName: "测试企业", paymentStatus: "paid", profile: true, integration: true, acceptance: true, training: true, videos: 2, revision: 4, goLiveAt: "2026-09-15T00:00:00Z" };
const account = { workspaceId: "workspace-1", accountId: "internal-account-uuid", identityId: "internal-identity-uuid", login: "merchant@example.test" };

describe("delivery account binding presentation", () => {
  it("shows only the real login for a bound record in read-only mode", () => {
    const html = renderToStaticMarkup(<CustomerDeliveryAccountBinding record={{ ...record, targetAccountId: account.accountId, targetIdentityId: account.identityId, targetAccountLogin: account.login }} readOnly onBound={() => {}} />);
    expect(html).toContain(account.login);
    expect(html).not.toContain(account.accountId);
    expect(html).not.toContain(account.identityId);
    expect(html).toContain("管理员停用、角色与付款限制仍独立生效");
    expect(html).not.toContain("确认关联账号");
  });
  it("does not promote legacy completion to activated-account status", () => {
    const html = renderToStaticMarkup(<CustomerDeliveryAccountBinding record={record} readOnly onBound={() => {}} />);
    expect(html).toContain("未关联。交付完成不代表账号已启用");
    expect(html).not.toContain("查询账号");
    expect(html).not.toContain('type="checkbox"');
  });
  it("fails closed for a corrupt partial binding rather than offering a new one", () => {
    const html = renderToStaticMarkup(<CustomerDeliveryAccountBinding record={{ ...record, targetAccountId: account.accountId }} onList={async () => ({ items: [account] })} onBind={async () => record} onBound={() => {}} />);
    expect(html).toContain("关联信息不完整");
    expect(html).not.toContain("查询账号");
    expect(html).not.toContain(account.accountId);
  });
  it("merges pagination without dropping previous accounts and rejects identity conflicts", () => {
    const second = { ...account, accountId: "account-2", identityId: "identity-2", login: "second@example.test" };
    expect(mergeCustomerDeliveryAccounts([account], [account, second])).toEqual([account, second]);
    expect(() => mergeCustomerDeliveryAccounts([account], [{ ...account, login: "changed" }])).toThrow("发生变化");
    expect(() => mergeCustomerDeliveryAccounts([account], [{ ...account, accountId: "other" }])).toThrow("冲突");
  });
});
