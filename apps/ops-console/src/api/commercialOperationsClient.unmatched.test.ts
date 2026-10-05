import {beforeEach,describe,expect,it,vi} from "vitest";
const rpc=vi.hoisted(()=>vi.fn());
vi.mock("./opsClient.js",()=>({rpc}));
import {commercialOperationsClient,parseCommercialReceipt,parseUnmatchedCashReceipt,parseUnmatchedReceiptPage,recoverCashIntent} from "./commercialOperationsClient.js";
const receipt={id:"cash_unmatched",workspaceId:null,source:"bank_transfer",receivingAccountRef:"approved_receiver",externalTradeId:"verified_bank_trade",payerRef:"original_payer",amountFen:200000,currency:"CNY",receivedAt:"2026-10-05T01:00:00Z",verifiedAt:"2026-10-05T02:00:00Z",allocatedFen:0,returnedFen:0,frozenReturnFen:0,availableFen:200000,revision:1};
describe("restricted unmatched cash contracts",()=>{
  beforeEach(()=>rpc.mockReset());
  it("keeps null ownership explicit and never manufactures a workspace",()=>{
    expect(parseUnmatchedCashReceipt({receipt}).workspaceId).toBeNull();
    expect(()=>parseCommercialReceipt({receipt})).toThrow();
    expect(()=>parseUnmatchedCashReceipt({...receipt,workspaceId:"synthetic_workspace"})).toThrow();
    expect(()=>parseUnmatchedCashReceipt({...receipt,workspaceId:undefined})).toThrow();
    expect(()=>parseUnmatchedCashReceipt({...receipt,availableFen:200001})).toThrow();
  });
  it("preserves opaque pagination and rejects a mixed ownership page",async()=>{
    rpc.mockResolvedValue({items:[receipt],next_cursor:"opaque_restricted_cursor"});
    const page=await commercialOperationsClient.listUnmatchedReceipts({limit:50,cursor:"original_cursor"});
    expect(page.nextCursor).toBe("opaque_restricted_cursor");
    expect(rpc.mock.calls[0]?.slice(0,2)).toEqual(["ops.commercial.receipt.unmatched.list",{limit:"50",cursor:"original_cursor"}]);
    expect(()=>parseUnmatchedReceiptPage({items:[receipt,{...receipt,id:"owned",workspaceId:"ws_other"}],next_cursor:null})).toThrow();
  });
  it("records factual bank cash without a workspace, order, grant or invented server nonce",async()=>{
    rpc.mockResolvedValue({receipt});
    await commercialOperationsClient.recordUnmatchedReceipt({receivingAccountRef:"approved_receiver",externalTradeId:"verified_bank_trade",payerRef:"original_payer",amountFen:200000,receivedAt:"2026-10-05T01:00:00Z",evidenceRef:"bank-evidence",reason:"verified ownership remains unknown"});
    expect(rpc.mock.calls[0]?.[0]).toBe("ops.commercial.receipt.unmatched.record");
    expect(rpc.mock.calls[0]?.[1]).toEqual({source:"bank_transfer",receiving_account_ref:"approved_receiver",external_trade_id:"verified_bank_trade",payer_ref:"original_payer",amount_fen:"200000",currency:"CNY",received_at:"2026-10-05T01:00:00Z",reason:"verified ownership remains unknown",evidence_json:JSON.stringify({evidence_ref:"bank-evidence"})});
  });
  it("matches only the original receipt to the explicitly selected enterprise with ownership evidence",async()=>{
    rpc.mockResolvedValue({receipt:{...receipt,workspaceId:"ws_verified",revision:2}});
    const input={workspace:"ws_verified",receiptId:receipt.id,customerRef:"verified_active_customer",reason:"verified ownership",evidenceRef:"ownership_evidence"};
    expect((await commercialOperationsClient.matchUnmatchedReceipt(input)).workspaceId).toBe("ws_verified");
    expect(rpc.mock.calls[0]?.slice(0,2)).toEqual(["ops.commercial.receipt.unmatched.match",{receipt_id:receipt.id,target_workspace_id:"ws_verified",reason:"verified ownership",evidence_json:JSON.stringify({ownership_evidence_ref:"ownership_evidence",matched_customer_ref:"verified_active_customer"})}]);
  });
});

describe("original cash intention recovery",()=>{
  beforeEach(()=>rpc.mockReset());
  it("uses original bank tuple lookup and preserves null rather than unlocking",async()=>{
    rpc.mockResolvedValueOnce(null).mockResolvedValueOnce({receipt});
    const intent={key:"record_original",kind:"record" as const,receivingAccountRef:receipt.receivingAccountRef,externalTradeId:receipt.externalTradeId,amountFen:receipt.amountFen,payerRef:receipt.payerRef,receivedAt:receipt.receivedAt};
    expect(await recoverCashIntent(commercialOperationsClient,intent)).toBe(false);
    expect(await recoverCashIntent(commercialOperationsClient,intent)).toBe(true);
    expect(rpc.mock.calls[0]?.slice(0,2)).toEqual(["ops.commercial.receipt.request.get",{source:"bank_transfer",receiving_account_ref:receipt.receivingAccountRef,external_trade_id:receipt.externalTradeId}]);
    rpc.mockResolvedValue({receipt:{...receipt,amountFen:200001,availableFen:200001}});
    expect(await recoverCashIntent(commercialOperationsClient,intent)).toBe(false);
  });
  it("requires every original batch allocation key and exact original money/receipt/order facts",async()=>{
    const line={receipt_id:"cash",order_id:"opening",amount_fen:500000,expected_revision:1};
    const second={...line,order_id:"first_period",amount_fen:200000};
    const allocation={allocationId:"allocation",receiptId:"cash",orderId:"opening",allocatedFen:500000,status:"fully_received"};
    rpc.mockResolvedValueOnce({allocation}).mockResolvedValueOnce(null);
    const intent={key:"same_batch",kind:"allocation" as const,workspace:"ws",batch:true,lines:[line,second]};
    expect(await recoverCashIntent(commercialOperationsClient,intent)).toBe(false);
    expect(rpc.mock.calls.map(call=>call[1])).toEqual([{target_workspace_id:"ws",idempotency_key:"same_batch:0"},{target_workspace_id:"ws",idempotency_key:"same_batch:1"}]);
    rpc.mockResolvedValueOnce({allocation}).mockResolvedValueOnce({allocation:{...allocation,allocationId:"second",orderId:"first_period",allocatedFen:200000}});
    expect(await recoverCashIntent(commercialOperationsClient,intent)).toBe(true);
    rpc.mockResolvedValueOnce({allocation}).mockResolvedValueOnce({allocation:{...allocation,orderId:"first_period",allocatedFen:200001}});
    expect(await recoverCashIntent(commercialOperationsClient,intent)).toBe(false);
  });
  it("does not infer matching from queue disappearance or another enterprise",async()=>{
    const intent={key:"match",kind:"match" as const,workspace:"ws_target",receiptId:receipt.id,receivingAccountRef:receipt.receivingAccountRef,externalTradeId:receipt.externalTradeId,amountFen:receipt.amountFen,payerRef:receipt.payerRef,receivedAt:receipt.receivedAt};
    rpc.mockResolvedValue({receipt:{...receipt,workspaceId:"other",revision:2}});
    expect(await recoverCashIntent(commercialOperationsClient,intent)).toBe(false);
    rpc.mockResolvedValue({receipt:{...receipt,workspaceId:"ws_target",revision:2}});
    expect(await recoverCashIntent(commercialOperationsClient,intent)).toBe(true);
    expect(rpc.mock.calls[0]?.[0]).toBe("ops.commercial.receipt.get");
  });
  it("uses restricted unmatched return methods and a real external reference",async()=>{
    rpc.mockResolvedValue({item:{}});
    await commercialOperationsClient.proposeUnmatchedReturn({receiptId:receipt.id,returnId:"original_return",amountFen:10000,payerRef:receipt.payerRef,expectedRevision:1,reason:"original payer",evidenceRef:"safe-ref"});
    await commercialOperationsClient.decideUnmatchedReturn({returnId:"original_return",action:"approve",evidenceRef:"approval"});
    await commercialOperationsClient.completeUnmatchedReturn({returnId:"original_return",outcome:"completed",externalReturnId:"real_bank_return",evidenceRef:"completion"});
    for(const call of rpc.mock.calls)expect(call[1]).not.toHaveProperty("target_workspace_id");
    expect(rpc.mock.calls.map(call=>call[0])).toEqual(["ops.commercial.receipt.unmatched.return.propose","ops.commercial.receipt.unmatched.return.decide","ops.commercial.receipt.unmatched.return.complete"]);
    expect(rpc.mock.calls[2]?.[1]).toMatchObject({external_return_id:"real_bank_return",outcome:"completed"});
  });
  it("requires the original return amount, payer and exact external outcome across pagination",async()=>{
    const item={id:"return",receiptId:receipt.id,amountFen:10000,payerRef:receipt.payerRef,status:"completed",requestedByActorId:"maker",approvedByActorId:"independent",externalReturnId:"real_return"};
    const intent={key:"complete",kind:"return" as const,returnId:"return",receiptId:receipt.id,amountFen:10000,payerRef:receipt.payerRef,action:"completed" as const,externalReturnId:"real_return"};
    rpc.mockResolvedValueOnce({items:[],next_cursor:"next"}).mockResolvedValueOnce({items:[item],next_cursor:null});
    expect(await recoverCashIntent(commercialOperationsClient,intent)).toBe(true);
    expect(rpc.mock.calls[1]?.[1]).toEqual({limit:"100",cursor:"next"});
    rpc.mockResolvedValue({items:[{...item,externalReturnId:"other_return"}],next_cursor:null});
    expect(await recoverCashIntent(commercialOperationsClient,intent)).toBe(false);
    rpc.mockResolvedValue({items:[{...item,status:"external_unknown",externalReturnId:null}],next_cursor:null});
    expect(await recoverCashIntent(commercialOperationsClient,intent)).toBe(false);
  });
});
