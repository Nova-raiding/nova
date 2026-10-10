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

describe('image generation ambiguous provider outcome recovery', () => {
  it('does not retry a model request after an ambiguous 503 and gives reconciliation guidance', async () => {
    let attempts = 0;
    const upstream = createServer((_request, response) => {
      attempts += 1;
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: {
        code: 'API_UNAVAILABLE',
        message: 'temporary relay interruption; provider diagnostics provider-debug-secret',
        details: { retryable: false, provider_request_id: 'provider-call-123', request_id: 'req_image_unknown_1' },
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
        MERCHANT_WORKSPACE_ID: 'ws_image_unknown_outcome',
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
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'catalog.image.generate', arguments: { product_id: 'product_fixture' },
      } })}\n`);
      const result = await nextLine(child.stdout);
      expect(result.result).toMatchObject({
        isError: true,
        structuredContent: {
          code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN',
          details: {
            request_id: 'req_image_unknown_1',
            provider_request_id: 'provider-call-123',
            provider_outcome: 'unknown',
            reconciliation_required: true,
            next_action: 'query_provider',
            retryable: false,
          },
        },
      });
      expect(result.result.content[0].text).toContain('已转入后台自动核对');
      expect(result.result.content[0].text).toContain('不会重复调用、重复扣费');
      expect(JSON.stringify(result.result)).not.toContain('provider-debug-secret');
      expect(attempts).toBe(1);
    } finally {
      child.kill();
      await once(child, 'exit').catch(() => undefined);
      upstream.close();
      await once(upstream, 'close').catch(() => undefined);
    }
  }, 5_000);
});
