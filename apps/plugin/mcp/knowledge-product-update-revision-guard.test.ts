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

describe('knowledge.product.update revision argument guard', () => {
  it('rejects malformed revisions before forwarding even when writes are enabled', async () => {
    let upstreamRequests = 0;
    const upstream = createServer((_request, response) => {
      upstreamRequests += 1;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: { result: { updated: true } }, error: null }));
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
        MERCHANT_WORKSPACE_ID: 'ws_product_update_revision_contract',
        MERCHANT_MCP_TOKEN: 'local-test-token',
        MERCHANT_MCP_REFRESH_TOKEN: '',
        MERCHANT_MCP_TOKEN_SOURCE: 'environment',
        MERCHANT_STRICT_AUTH: 'true',
        MERCHANT_MCP_WRITE_ENABLED: 'true',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const invalidRevisions: unknown[] = ['0', '-1', '1.5', '01', '12345678901', 1, null, ' 1 '];
      for (const [index, expected_revision] of invalidRevisions.entries()) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: {
          name: 'knowledge.product.update',
          arguments: {
            product_id: 'product_local',
            asset_id: 'fact_local',
            expected_revision,
            approval_status: 'approved',
            reason: 'verified from supplier invoice',
          },
        } })}\n`);
        const result = await nextLine(child.stdout);
        expect(result.result, `revision ${String(expected_revision)}`).toMatchObject({ isError: true, structuredContent: { code: 'TOOL_ARGUMENTS_INVALID' } });
      }
      expect(upstreamRequests).toBe(0);
    } finally {
      child.kill();
      await once(child, 'exit').catch(() => undefined);
      upstream.close();
      await once(upstream, 'close').catch(() => undefined);
    }
  }, 5_000);

  it('forwards the expected revision in the bound workspace and returns permission denial without retry', async () => {
    const requests: Array<{ headers: import('node:http').IncomingHttpHeaders; body: Record<string, any> }> = [];
    const upstream = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk.toString();
      requests.push({ headers: request.headers, body: JSON.parse(body) });
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: {
        code: 'PERMISSION_DENIED',
        message: 'Knowledge editor permission is required.',
        details: { reason_code: 'KNOWLEDGE_GOVERNANCE_ROLE_REQUIRED' },
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
        MERCHANT_WORKSPACE_ID: 'ws_product_update_revision_contract',
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
        name: 'knowledge.product.update',
        arguments: {
          product_id: 'product_local',
          asset_id: 'fact_local',
          expected_revision: '7',
          approval_status: 'approved',
          reason: 'verified from supplier invoice',
        },
      } })}\n`);
      const result = await nextLine(child.stdout);
      expect(result.result).toMatchObject({
        isError: true,
        structuredContent: { code: 'PERMISSION_DENIED', details: { reason_code: 'KNOWLEDGE_GOVERNANCE_ROLE_REQUIRED' } },
      });
      expect(result.result.content[0].text).toContain('没有执行这一步的权限');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.body).toMatchObject({
        method: 'knowledge.product.update',
        params: {
          workspace_id: 'ws_product_update_revision_contract',
          product_id: 'product_local',
          asset_id: 'fact_local',
          expected_revision: '7',
          approval_status: 'approved',
        },
      });
      expect(requests[0]?.headers['x-workspace-id']).toBe('ws_product_update_revision_contract');
    } finally {
      child.kill();
      await once(child, 'exit').catch(() => undefined);
      upstream.close();
      await once(upstream, 'close').catch(() => undefined);
    }
  }, 5_000);
});
