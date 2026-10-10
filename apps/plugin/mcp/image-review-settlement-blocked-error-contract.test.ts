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

describe('catalog.image.review settlement-blocked error projection', () => {
  it('preserves non-retryable reconciliation state without exposing internal diagnostics', async () => {
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
          code: 'IMAGE_GENERATION_SETTLEMENT_EVIDENCE_PENDING',
          message: 'Candidate settlement evidence is still being reconciled; internal-ledger-secret',
          details: {
            reconciliation_required: true,
            retryable: false,
            request_id: 'req_image_review_settlement_local',
            provider_error_summary: 'Authorization: Bearer private-provider-diagnostic',
            provider_access_token: 'private-provider-diagnostic',
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
        MERCHANT_WORKSPACE_ID: 'ws_image_review_settlement',
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
        name: 'catalog.image.review', arguments: { product_id: 'product_local', visual_refs_json: '["visual_local"]' },
      } })}\n`);
      const response = await nextLine(child.stdout);
      expect(response.result).toMatchObject({
        isError: true,
        structuredContent: {
          code: 'IMAGE_GENERATION_SETTLEMENT_EVIDENCE_PENDING',
          details: {
            reconciliation_required: true,
            retryable: false,
            request_id: 'req_image_review_settlement_local',
          },
        },
      });
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0]).toMatchObject({ method: 'catalog.image.review', params: {
        product_id: 'product_local', visual_refs_json: '["visual_local"]', workspace_id: 'ws_image_review_settlement',
      } });
      const serialized = JSON.stringify(response.result);
      expect(serialized).not.toContain('internal-ledger-secret');
      expect(serialized).not.toContain('private-provider-diagnostic');
      expect(response.result.content[0].text).not.toContain('稍后重试');
    } finally {
      child.kill();
      await once(child, 'exit').catch(() => undefined);
      upstream.close();
      await once(upstream, 'close').catch(() => undefined);
    }
  }, 5_000);
});
