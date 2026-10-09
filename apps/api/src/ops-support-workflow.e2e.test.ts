import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "./server.js";

type RpcEnvelope<T = unknown> = { data: { result: T } | null; error: { code: string; message: string } | null };

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", onError); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Ops support workflow server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

describe("Ops support workflow over loopback MCP", () => {
  beforeEach(() => vi.stubEnv("API_RATE_LIMIT_PER_MINUTE", "10000"));
  afterEach(async () => {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    vi.unstubAllEnvs();
  });

  it("assigns a ticket, sends a customer-visible reply, resolves and closes with an ordered event trail", async () => {
    const base = await start();
    const workspaceId = `ws_support_flow_${randomUUID()}`;
    const identity = randomUUID().replaceAll("-", "");
    const call = async <T>(method: string, params: Record<string, unknown>) => fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-workspace-id": workspaceId, "x-ops-workbench": "workspace", "x-role": "support", "x-actor-id": "support-flow-operator" },
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params: { workspace_id: workspaceId, ...params } }),
    }).then(response => response.json() as Promise<RpcEnvelope<T>>);

    const created = await call<{ ticket: { id: string; revision: number; status: string } }>("ops.support.ticket.create", {
      subject: "充值余额未更新", description: "客户支付成功后钱包余额没有及时更新，请核对支付回调。", priority: "high",
      customer_id: `customer_${identity}`, customer_name: "隔离测试商户", customer_email: "owner@example.test",
      tags_json: JSON.stringify(["payment"]), idempotency_key: `support-flow-create-${identity}`,
    });
    expect(created.error).toBeNull();
    expect(created.data?.result.ticket).toMatchObject({ revision: 1, status: "open" });
    const ticketId = created.data!.result.ticket.id;

    const assigned = await call<{ ticket: { revision: number; assignedTo: string }; event: { eventType: string } }>("ops.support.ticket.assign", {
      ticket_id: ticketId, assignee_id: "support-owner-42", expected_revision: "1", idempotency_key: `support-flow-assign-${identity}`,
    });
    expect(assigned.error).toBeNull();
    expect(assigned.data?.result).toMatchObject({ ticket: { revision: 2, assignedTo: "support-owner-42" }, event: { eventType: "assigned" } });

    const started = await call<{ ticket: { revision: number; status: string } }>("ops.support.ticket.transition", {
      ticket_id: ticketId, status: "in_progress", reason: "负责人已接手核对支付回调", expected_revision: "2", idempotency_key: `support-flow-start-${identity}`,
    });
    expect(started.error).toBeNull();
    expect(started.data?.result.ticket).toMatchObject({ revision: 3, status: "in_progress" });

    const reply = await call<{ ticket: { revision: number }; event: { eventType: string; payload: Record<string, unknown> } }>("ops.support.ticket.comment", {
      ticket_id: ticketId, body: "已核对到账记录，余额现已修复。", visibility: "customer", expected_revision: "3", idempotency_key: `support-flow-reply-${identity}`,
    });
    expect(reply.error).toBeNull();
    expect(reply.data?.result).toMatchObject({ ticket: { revision: 4 }, event: { eventType: "commented", payload: { visibility: "customer" } } });

    const resolved = await call<{ ticket: { revision: number; status: string } }>("ops.support.ticket.transition", {
      ticket_id: ticketId, status: "resolved", reason: "客户问题已处理并已发送回复", expected_revision: "4", idempotency_key: `support-flow-resolve-${identity}`,
    });
    expect(resolved.error).toBeNull();
    expect(resolved.data?.result.ticket).toMatchObject({ revision: 5, status: "resolved" });

    const closed = await call<{ ticket: { revision: number; status: string } }>("ops.support.ticket.transition", {
      ticket_id: ticketId, status: "closed", reason: "客户确认后关闭工单", expected_revision: "5", idempotency_key: `support-flow-close-${identity}`,
    });
    expect(closed.error).toBeNull();
    expect(closed.data?.result.ticket).toMatchObject({ revision: 6, status: "closed" });

    const detail = await call<{ ticket: { assignedTo: string; status: string }; events: Array<{ eventType: string; sequence: number }> }>("ops.support.ticket.get", { ticket_id: ticketId });
    expect(detail.error).toBeNull();
    expect(detail.data?.result.ticket).toMatchObject({ assignedTo: "support-owner-42", status: "closed" });
    expect(detail.data?.result.events.map(event => [event.sequence, event.eventType])).toEqual([
      [1, "created"], [2, "assigned"], [3, "status_changed"], [4, "commented"], [5, "status_changed"], [6, "status_changed"],
    ]);
  });
});
