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

describe('rule.sync.status MCP read-only contract', () => {
  it('keeps rule freshness inspection available with writes disabled and workspace scoped', async () => {
    const forwarded: Array<{ method?: string; body?: { method?: string; params?: Record<string, unknown> } }> = [];
    const upstream = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        forwarded.push({ method: request.method, body: JSON.parse(body) });
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ data: { result: [{ platform: 'jd', freshness: 'current', version: 'v-local' }] }, error: null }));
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
        MERCHANT_WORKSPACE_ID: 'ws_rule_sync_contract',
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
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'rule.sync.status')).toMatchObject({
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      });

      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'rule.sync.status', arguments: { interval_hours: '12' } },
      })}\n`);
      const result = await nextLine(child.stdout);
      expect(result.result.isError).toBe(false);
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0]).toMatchObject({
        method: 'POST',
        body: { method: 'rule.sync.status', params: { interval_hours: '12', workspace_id: 'ws_rule_sync_contract' } },
      });
    } finally {
      child.kill();
      await once(child, 'exit').catch(() => undefined);
      upstream.close();
      await once(upstream, 'close').catch(() => undefined);
    }
  }, 5_000);
});
