import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const bridge = new URL('./bridge.mjs', import.meta.url);

async function nextLine(stream: NodeJS.ReadableStream): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      cleanup();
      resolve(JSON.parse(buffer.slice(0, newline)));
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onEnd = () => { cleanup(); reject(new Error('bridge closed before response')); };
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('error', onError);
      stream.off('end', onEnd);
    };
    stream.on('data', onData);
    stream.once('error', onError);
    stream.once('end', onEnd);
  });
}

describe('catalog.image.select expired-ticket error projection', () => {
  it('preserves the expired-ticket code and never repeats the candidate selection', async () => {
    const forwarded: Array<{ method?: string; params?: Record<string, unknown> }> = [];
    const upstream = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        forwarded.push(JSON.parse(body));
        response.statusCode = 409;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ error: {
          code: 'INTERACTIVE_CONFIRMATION_TICKET_EXPIRED',
          message: 'The candidate selection ticket expired; refresh the candidate before selecting again.',
          details: {
            operation_status: 'rejected',
            retryable: false,
            next_action: 'catalog.image.get',
            request_id: 'req_image_select_expired_local',
            authorization: 'Bearer private-ticket-verifier',
          },
        } }));
      });
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('mock API did not bind');

    const child = spawn(process.execPath, [bridge.pathname], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DEPLOY_ENV: 'local_desktop',
        MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`,
        MERCHANT_WORKSPACE_ID: 'ws_image_select_expired',
        MERCHANT_MCP_TOKEN: 'local-test-token',
        MERCHANT_MCP_REFRESH_TOKEN: '',
        MERCHANT_MCP_TOKEN_SOURCE: 'environment',
        MERCHANT_STRICT_AUTH: 'true',
        MERCHANT_MCP_WRITE_ENABLED: 'false',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'catalog.image.select', arguments: {
          job_id: 'job_local', visual_ref: 'visual_local', expected_revision: '4',
          idempotency_key: 'image-select-local', reason: '用户选择候选主图',
          confirmation_ticket_nonce_hash: 'a'.repeat(64), confirmation_ticket_intent_hash: 'b'.repeat(64),
        },
      } })}\n`);
      const result = await nextLine(child.stdout);
      expect(result.result).toMatchObject({
        isError: true,
        structuredContent: {
          code: 'INTERACTIVE_CONFIRMATION_TICKET_EXPIRED',
          details: {
            operation_status: 'rejected',
            retryable: false,
            next_action: 'catalog.image.get',
            request_id: 'req_image_select_expired_local',
          },
        },
      });
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0]?.method).toBe('catalog.image.select');
      const serialized = JSON.stringify(result.result);
      expect(serialized).not.toContain('private-ticket-verifier');
      expect(serialized).not.toContain('Bearer');
      expect(result.result.content[0].text).not.toContain('重新提交');
    } finally {
      child.kill();
      await once(child, 'exit').catch(() => undefined);
      upstream.close();
      await once(upstream, 'close').catch(() => undefined);
    }
  }, 5_000);
});
