import type { CommentOnSupportTicketCommand, SupportTicketEventContract, SupportTicketPageCursor } from "../../../../packages/contracts/src/ops/support.js";
import { parseSupportDetail, parseSupportMutation, parseSupportPage } from "./opsDomainClients.js";
import { rpc } from "./opsClient.js";

const mismatch = () => { throw new Error("服务器工单与所选企业或原意图不一致；停止回复并重新读取。"); };
export const platformSupportClient = {
  list: async (workspace: string, cursor?: SupportTicketPageCursor) => {
    const page = parseSupportPage(await rpc("ops.support.platform.tickets.list", { target_workspace_id: workspace, limit:"20", ...(cursor?{cursor_json:JSON.stringify(cursor)}:{}) }));
    if(page.items.some(ticket=>ticket.workspaceId!==workspace || ticket.aggregate))mismatch();
    return page;
  },
  get: async (workspace: string, ticketId: string) => {
    const detail = parseSupportDetail(await rpc("ops.support.platform.ticket.get",{target_workspace_id:workspace,ticket_id:ticketId}));
    if(detail && (detail.ticket.workspaceId!==workspace || detail.ticket.id!==ticketId || detail.ticket.aggregate || detail.events.some(event=>event.workspaceId!==workspace || event.ticketId!==ticketId)))mismatch();
    return detail;
  },
  comment: async (input: CommentOnSupportTicketCommand) => {
    const result=parseSupportMutation(await rpc("ops.support.platform.ticket.comment",{target_workspace_id:input.workspaceId,ticket_id:input.ticketId,body:input.body,visibility:input.visibility,expected_revision:String(input.expectedRevision),idempotency_key:input.idempotencyKey}));
    if(result.ticket.workspaceId!==input.workspaceId || result.ticket.id!==input.ticketId || result.event.workspaceId!==input.workspaceId || result.event.ticketId!==input.ticketId || result.event.idempotencyKey!==input.idempotencyKey || result.event.eventType!=="commented")mismatch();
    return result;
  },
};
export type PlatformSupportClient=typeof platformSupportClient;
export interface PlatformReplyIntent { workspaceId:string; ticketId:string; actorId:string; idempotencyKey:string; visibility:"customer"|"internal"; expectedRevision:number; bodyHash:string }
export async function supportBodyHash(body:string):Promise<string> {const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(body));return [...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,"0")).join("");}
export async function matchesPlatformReply(event:SupportTicketEventContract,intent:PlatformReplyIntent):Promise<boolean> {
  return event.workspaceId===intent.workspaceId && event.ticketId===intent.ticketId && event.eventType==="commented" && event.actorId===intent.actorId && event.idempotencyKey===intent.idempotencyKey && event.payload.visibility===intent.visibility && typeof event.payload.body==="string" && (event.payload.expectedRevision===undefined || event.payload.expectedRevision===intent.expectedRevision) && await supportBodyHash(event.payload.body)===intent.bodyHash;
}
