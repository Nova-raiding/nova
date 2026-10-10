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

describe('brand profile scoped read contract', () => {
  it('reads the explicitly selected brand unit within the current workspace', async () => {
    const received: Array<{ jsonrpc?: string; id?: string | number; method: string; params?: Record<string, unknown> }> = [];
    const profile = {
      id: 'brand-profile-fixture',
      brandUnitId: 'brand-unit-selected',
      brandUnitSelectionRequired: false,
      displayName: '北岸户外',
      revision: 6,
    };
    const upstream = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        received.push(JSON.parse(body) as { jsonrpc?: string; id?: string | number; method: string; params?: Record<string, unknown> });
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ data: { result: profile }, error: null }));
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
        MERCHANT_WORKSPACE_ID: 'ws_brand_profile_read',
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
        name: 'brand.get', arguments: { brand_unit_id: 'brand-unit-selected' },
      } })}\n`);
      const result = await nextLine(child.stdout);
      expect(result.result).toMatchObject({ isError: false, structuredContent: profile });
      expect(result.result.content[0].text).toContain('已关联批量生产品牌单元 brand-unit-selected');
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        method: 'brand.get',
        params: { brand_unit_id: 'brand-unit-selected', workspace_id: 'ws_brand_profile_read' },
      });
    } finally {
      child.kill();
      await once(child, 'exit').catch(() => undefined);
      upstream.close();
      await once(upstream, 'close').catch(() => undefined);
    }
  }, 5_000);
});
