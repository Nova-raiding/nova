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

describe('image generation exhausted-points recovery boundary', () => {
  it('blocks another image generation after zero balance and keeps only approved recovery actions', async () => {
    const received: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const upstream = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        const call = JSON.parse(body) as { method: string; params?: Record<string, unknown> };
        received.push(call);
        response.writeHead(402, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: {
          code: 'CREATIVE_POINTS_EXHAUSTED',
          message: 'balance exhausted',
          details: {
            balance_state: 'known',
            available_points: 0,
            request_id: 'req_image_points_empty',
            next_actions: ['billing.status', 'catalog.image.generate', 'platform.connect'],
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
        MERCHANT_WORKSPACE_ID: 'ws_image_points_empty',
        MERCHANT_MCP_TOKEN: 'local-test-token',
        MERCHANT_MCP_REFRESH_TOKEN: '',
        MERCHANT_MCP_TOKEN_SOURCE: 'environment',
        MERCHANT_STRICT_AUTH: 'true',
        MERCHANT_MCP_WRITE_ENABLED: 'true',
        MERCHANT_MCP_RETRY_ATTEMPTS: '5',
        MERCHANT_MCP_RETRY_DELAY_MS: '50',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const call = async (id: number) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: {
        name: 'catalog.image.generate', arguments: { product_id: 'product_fixture' },
      } })}\n`);
      return nextLine(child.stdout);
    };
    try {
      const exhausted = await call(1);
      expect(exhausted.result).toMatchObject({
        isError: true,
        structuredContent: {
          code: 'CREATIVE_POINTS_EXHAUSTED',
          recovery_only: true,
          availability: 'exhausted',
          balance_state: 'known',
          request_id: 'req_image_points_empty',
          next_actions: ['billing.status'],
        },
      });
      expect(exhausted.result.content[0].text).toContain('本次请求已阻断');

      const blockedRetry = await call(2);
      expect(blockedRetry.result).toMatchObject({ isError: true, structuredContent: { code: 'CREATIVE_POINTS_EXHAUSTED', recovery_only: true } });
      expect(blockedRetry.result.content[0].text).toContain('创意点已用完');
      // The user copy explains the exhausted balance; the transport assertion
      // below is the authoritative proof that the second call was blocked
      // locally and did not reach the API.
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ method: 'catalog.image.generate', params: { workspace_id: 'ws_image_points_empty' } });
    } finally {
      child.kill();
      await once(child, 'exit').catch(() => undefined);
      upstream.close();
      await once(upstream, 'close').catch(() => undefined);
    }
  }, 5_000);
});
