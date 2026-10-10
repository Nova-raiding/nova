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

describe('billing.status error projection', () => {
  it('retains retryability while removing provider secrets from the merchant result', async () => {
    const upstream = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.statusCode = 503;
      response.end(JSON.stringify({ error: {
        code: 'API_UNAVAILABLE',
        message: 'Bearer upstream-token must not be shown',
        details: {
          retryable: true,
          request_id: 'req_batch_status_local',
          provider_error_summary: 'Authorization: Bearer provider-secret',
          provider_access_token: 'provider-secret',
        },
      } }));
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
        MERCHANT_WORKSPACE_ID: 'ws_publish_batch_error_contract',
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
        name: 'billing.status', arguments: {},
      } })}\n`);
      const response = await nextLine(child.stdout);
      expect(response.result.isError).toBe(true);
      expect(response.result.structuredContent).toMatchObject({
        code: 'API_UNAVAILABLE',
        details: { retryable: true, request_id: 'req_batch_status_local' },
      });
      const serialized = JSON.stringify(response.result);
      expect(serialized).not.toContain('upstream-token');
      expect(serialized).not.toContain('provider-secret');
      expect(response.result.content[0].text).toContain('稍后重试');
    } finally {
      child.kill();
      await once(child, 'exit').catch(() => undefined);
      upstream.close();
      await once(upstream, 'close').catch(() => undefined);
    }
  }, 5_000);
});
