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

describe('content visual selection result contract', () => {
  it('forwards the explicit selection once and keeps the new content version pending review', async () => {
    const received: Array<{ method: string; params?: Record<string, unknown>; headers: Record<string, string | string[] | undefined> }> = [];
    const upstream = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        const call = JSON.parse(body) as { method: string; params?: Record<string, unknown> };
        received.push({ ...call, headers: request.headers });
        response.setHeader('content-type', 'application/json');
        const result = call.method === 'workspace.interactive.confirm'
          ? { enabled: true }
          : {
              content_version_id: 'version_visual_pending',
              state: 'pending_review',
              visualSelection: {
                state: 'selected',
                count: 1,
                items: [{ visualRef: 'visual_fixture_1', ordinal: 1, mimeType: 'image/png', reviewStatus: 'pending', publishable: false }],
              },
              reviewRequired: true,
              approvalRequired: true,
              publishable: false,
            };
        response.end(JSON.stringify({ data: { result }, error: null }));
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
        MERCHANT_WORKSPACE_ID: 'ws_visual_select_contract',
        MERCHANT_MCP_TOKEN: 'local-test-token',
        MERCHANT_MCP_REFRESH_TOKEN: '',
        MERCHANT_MCP_TOKEN_SOURCE: 'environment',
        MERCHANT_STRICT_AUTH: 'true',
        MERCHANT_MCP_WRITE_ENABLED: 'true',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const selectionArguments = {
      content_version_id: 'version_source_fixture',
      visual_refs_json: '["visual_fixture_1"]',
      expected_revision: '4',
      idempotency_key: 'visual-select-local-01',
      reason: '用户确认配图顺序',
    };
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'content.visual.select', arguments: selectionArguments,
      } })}\n`);
      const selected = await nextLine(child.stdout);
      expect(selected.result).toMatchObject({
        isError: false,
        structuredContent: {
          content_version_id: 'version_visual_pending',
          state: 'pending_review',
          visualSelection: {
            state: 'selected',
            count: 1,
            items: [{ visualRef: 'visual_fixture_1', ordinal: 1, publishable: false }],
          },
          reviewRequired: true,
          approvalRequired: true,
          publishable: false,
        },
      });
      expect(received.map(call => call.method)).toEqual(['content.visual.select']);
      expect(received[0]?.params).toMatchObject({
        ...selectionArguments,
        workspace_id: 'ws_visual_select_contract',
      });
      expect(received[0]?.headers['idempotency-key']).toBe('visual-select-local-01');
    } finally {
      child.kill();
      await once(child, 'exit').catch(() => undefined);
      upstream.close();
      await once(upstream, 'close').catch(() => undefined);
    }
  }, 5_000);
});
