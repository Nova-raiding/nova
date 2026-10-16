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

describe('deliverable.list MCP read-only contract', () => {
  it('advertises a read-only tool and rejects unsupported arguments before API forwarding', async () => {
    let upstreamRequests = 0;
    const upstream = createServer((_request, response) => {
      upstreamRequests += 1;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: { result: { state: 'queued' } }, error: null }));
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
        MERCHANT_WORKSPACE_ID: 'ws_catalog_sync_contract',
        MERCHANT_MCP_TOKEN: 'local-test-token',
        MERCHANT_MCP_REFRESH_TOKEN: '',
        MERCHANT_MCP_TOKEN_SOURCE: 'environment',
        MERCHANT_STRICT_AUTH: 'true',
        MERCHANT_MCP_WRITE_ENABLED: 'false',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
      const listed = await nextLine(child.stdout);
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'deliverable.list')).toMatchObject({
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      });

      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'deliverable.list', arguments: { query: 'sku local', unexpected: 'extra' } },
      })}\n`);
      const rejected = await nextLine(child.stdout);
      expect(rejected.result).toMatchObject({ isError: true, structuredContent: { code: 'TOOL_ARGUMENTS_INVALID' } });
      for (const limit of ['0', '51', '100', '1.5', '-1', 'abc']) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: `invalid-${limit}`, method: 'tools/call',
          params: { name: 'deliverable.list', arguments: { limit } } })}\n`);
        const invalidLimit = await nextLine(child.stdout);
        expect(invalidLimit.result).toMatchObject({ isError: true, structuredContent: { code: 'TOOL_ARGUMENTS_INVALID' } });
      }
      expect(upstreamRequests).toBe(0);
      for (const limit of ['1', '20', '50']) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: `valid-${limit}`, method: 'tools/call',
          params: { name: 'deliverable.list', arguments: { limit } } })}\n`);
        const validLimit = await nextLine(child.stdout);
        expect(validLimit.result.isError).not.toBe(true);
      }
      expect(upstreamRequests).toBe(3);
    } finally {
      child.kill();
      await once(child, 'exit').catch(() => undefined);
      upstream.close();
      await once(upstream, 'close').catch(() => undefined);
    }
  }, 5_000);
});
