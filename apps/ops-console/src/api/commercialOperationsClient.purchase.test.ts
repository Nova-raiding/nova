import { beforeEach, describe, expect, it, vi } from "vitest";
const rpc = vi.hoisted(() => vi.fn());
vi.mock("./opsClient.js", () => ({ rpc }));
import { commercialOperationsClient, parseAssistedOrderPreview, parseAllocationBatchPreview, parseAssistedCheckoutPreview, parseAssistedUpgradeQuote } from "./commercialOperationsClient.js";
const receipt = { id:"r1",workspaceId:"ws1",source:"bank_transfer",receivingAccountRef:"approved",externalTradeId:"bank1",payerRef:"payer1",amountFen:700000,currency:"CNY",receivedAt:"2026-10-05T01:00:00Z",verifiedAt:"2026-10-05T02:00:00Z",allocatedFen:0,returnedFen:0,frozenReturnFen:0,availableFen:700000,revision:1 };
const line = (order: string,amount: number) => ({ workspace_id:"ws1",receipt,order:{id:order,amountFen:amount},sku_code:"sku",amount_fen:amount,expected_revision:1,available_after_fen:700000-amount,fulfillment_state:"verification_required",preview_hash:`hash-${order}`,expires_at:"2026-10-05T02:05:00Z" });
describe("operator-assisted financial contracts", () => {
  beforeEach(() => rpc.mockReset());
  it("keeps the same server facts and idempotency key for confirm retries",async () => {
    rpc.mockResolvedValue({});
    const input = { workspace:"ws1",receiptId:"r1",orderId:"o1",amountFen:200000,expectedRevision:1,previewHash:"server-sha",idempotencyKey:"original-key",reason:"verified" };
    await commercialOperationsClient.confirmReceiptAllocation(input);
    await commercialOperationsClient.confirmReceiptAllocation(input);
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
    expect(rpc.mock.calls[0]?.[1]).toEqual({ target_workspace_id:"ws1",receipt_id:"r1",order_id:"o1",amount_fen:"200000",expected_revision:"1",preview_hash:"server-sha",idempotency_key:"original-key",reason:"verified" });
  });
  it("keeps first-purchase lines in one atomic checkout and batch",async () => {
    rpc.mockResolvedValue({});
    await commercialOperationsClient.createAssistedCheckout({ workspace:"ws1",beneficiaryMemberId:"member-id",onboardingSkuCode:"open",subscriptionSkuCode:"basic",reason:"customer_authorized",previewHash:"approved_snapshot",idempotencyKey:"checkout_key" });
    expect(rpc.mock.calls[0]?.[0]).toBe("ops.commercial.checkout.create");
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({beneficiary_member_id:"member-id",onboarding_sku_code:"open",subscription_sku_code:"basic",preview_hash:"approved_snapshot",idempotency_key:"checkout_key"});
    const allocations = [{receipt_id:"r1",order_id:"open-order",amount_fen:500000,expected_revision:1},{receipt_id:"r1",order_id:"first-order",amount_fen:200000,expected_revision:1}];
    await commercialOperationsClient.confirmReceiptAllocationBatch({workspace:"ws1",allocations,previewHash:"batch_hash",idempotencyKey:"batch_key"});
    expect(JSON.parse(rpc.mock.calls[1]?.[1].allocations_json)).toEqual(allocations);
    expect(parseAllocationBatchPreview({items:[line("open-order",500000),line("first-order",200000)],preview_hash:"batch_hash",expires_at:"2026-10-05T02:05:00Z"}).items).toHaveLength(2);
    expect(() => parseAllocationBatchPreview({items:[line("open-order",500000),line("first-order",300000)],preview_hash:"batch_hash",expires_at:"2026-10-05T02:05:00Z"})).toThrow();
  });
  it("binds assisted purchases and first checkouts to one explicit merchant member",async()=>{
    rpc.mockResolvedValueOnce({workspace_id:"ws1",beneficiary_member_id:"member-1",sku_code:"growth",purchase_kind:"upgrade",amount_fen:10000,currency:"CNY",snapshot:{name:"成长",version_id:"frozen",benefits:[]},onboarding_qualified:true,current:null,future:[],reason:"customer_authorized",preview_hash:"hash",expires_at:"2026-10-05T02:05:00Z"});
    await commercialOperationsClient.previewAssistedOrder({workspace:"ws1",beneficiaryMemberId:"member-1",skuCode:"growth",purchaseKind:"upgrade",reason:"customer_authorized"});
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({target_workspace_id:"ws1",beneficiary_member_id:"member-1",sku_code:"growth"});
    rpc.mockResolvedValueOnce({workspace_id:"ws1",amount_fen:700000,currency:"CNY",lines:[{purchase_kind:"onboarding_once",snapshot:{sku_code:"open",name:"开户",version_id:"open-v1",benefits:[]},amount_fen:500000},{purchase_kind:"purchase",snapshot:{sku_code:"basic",name:"基础",version_id:"basic-v1",benefits:[]},amount_fen:200000,depends_on:"onboarding_once"}],onboarding_qualified:false,current:null,future:[],reason:"customer_authorized",preview_hash:"checkout-hash",expires_at:"2026-10-05T02:05:00Z"});
    await commercialOperationsClient.previewAssistedCheckout({workspace:"ws1",beneficiaryMemberId:"member-1",onboardingSkuCode:"open",subscriptionSkuCode:"basic",reason:"customer_authorized"});
    expect(rpc.mock.calls[1]?.[1]).toMatchObject({target_workspace_id:"ws1",beneficiary_member_id:"member-1"});
  });
  it("does not offer a malformed server preview as a successful price", () => {
    const preview = {workspace_id:"ws1",beneficiary_member_id:"member-id",sku_code:"growth",purchase_kind:"upgrade",amount_fen:10000,currency:"CNY",snapshot:{name:"成长",version_id:"frozen",cycle:{unit:"month",count:1},benefits:[]},onboarding_qualified:true,current:{id:"current"},future:[],reason:"authorized",preview_hash:"server_sha",expires_at:"2026-10-05T02:05:00Z"};
    expect(parseAssistedOrderPreview(preview).amountFen).toBe(10000);
    expect(() => parseAssistedOrderPreview({...preview,currency:"USD"})).toThrow();
    expect(() => parseAssistedOrderPreview({...preview,amount_fen:0.1})).toThrow();
    expect(() => parseAssistedOrderPreview({...preview,snapshot:null})).toThrow();
  });
  it("requires exact first-purchase sum and the first-period dependency", () => {
    const snapshot = {name:"approved",version_id:"v1",sku_code:"sku",cycle:{unit:"month",count:1},benefits:[]};
    const lines = [{purchase_kind:"onboarding_once",snapshot,amount_fen:500000},{purchase_kind:"purchase",snapshot,amount_fen:200000,depends_on:"onboarding_once"}];
    const preview = {workspace_id:"ws1",amount_fen:700000,currency:"CNY",lines,onboarding_qualified:false,current:null,future:[],reason:"approved",preview_hash:"sha",expires_at:"2026-10-05T02:05:00Z"};
    expect(parseAssistedCheckoutPreview(preview).lines).toHaveLength(2);
    expect(() => parseAssistedCheckoutPreview({...preview,amount_fen:500000})).toThrow();
    expect(() => parseAssistedCheckoutPreview({...preview,lines:[lines[0],{...lines[1],depends_on:null}]})).toThrow();
  });
  it("reads the actual quote snake contract without client proration", () => {
    const quote = {upgrade_quote_id:"q1",workspace_id:"ws1",target_sku_code:"growth",amount_fen:150000,current_cycle_price_fen:200000,target_cycle_price_fen:500000,remaining_ms:100,total_ms:200,period_start:"2026-10-01T00:00:00Z",period_end:"2026-11-01T00:00:00Z",expires_at:"2026-10-05T02:05:00Z",benefit_increment_details:[{code:"creative_points",quantity:100}]};
    expect(parseAssistedUpgradeQuote(quote)).toMatchObject({id:"q1",amountFen:150000,periodEnd:"2026-11-01T00:00:00Z"});
    expect(() => parseAssistedUpgradeQuote({...quote,remaining_ms:201})).toThrow();
    expect(() => parseAssistedUpgradeQuote({...quote,expires_at:"unknown"})).toThrow();
  });
  it("looks up original actor-bound requests without creating new purchases",async () => {
    rpc.mockResolvedValue({});
    await commercialOperationsClient.getAssistedOrderRequest("ws1","original_key");
    expect(rpc.mock.calls[0]?.slice(0,2)).toEqual(["ops.commercial.order.request.get",{target_workspace_id:"ws1",idempotency_key:"original_key"}]);
  });
});
