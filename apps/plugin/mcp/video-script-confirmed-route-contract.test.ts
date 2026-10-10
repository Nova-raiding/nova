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

describe('confirmed video script request route', () => {
  it('forwards only after current-session confirmation and preserves draft-only execution evidence', async () => {
    const received: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const upstream = createServer(async (request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        const call = JSON.parse(body) as { method: string; params?: Record<string, unknown> };
        received.push(call);
        response.setHeader('content-type', 'application/json');
        const result = call.method === 'workspace.interactive.confirm'
          ? { enabled: true }
          : {
              candidate_only: true,
              publishable: false,
              execution: { status: 'completed', mode: 'simulated', simulated: true, providerExecuted: false },
              plan: { title: '通勤轻量商品视频脚本', scenes: [{ shot: 1, narration: '展示商品细节' }] },
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
        MERCHANT_WORKSPACE_ID: 'ws_video_script_route',
        MERCHANT_MCP_TOKEN: 'local-test-token',
        MERCHANT_MCP_REFRESH_TOKEN: '',
        MERCHANT_MCP_TOKEN_SOURCE: 'environment',
        MERCHANT_STRICT_AUTH: 'true',
        MERCHANT_MCP_WRITE_ENABLED: 'true',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'multimodal.video.request',
        arguments: { prompt: '突出轻便与通勤收纳', output: 'script', context_json: JSON.stringify({ product: { id: 'product_local', version: '3' }, brand: { id: 'brand_local', version: '2' }, rules: [] }), idempotency_key: 'video-script-local-01' },
      } })}\n`);
      const blocked = await nextLine(child.stdout);
      expect(blocked.result).toMatchObject({ isError: true, structuredContent: { code: 'INTERACTIVE_WRITE_DISABLED' } });
      expect(received).toHaveLength(0);

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
        name: 'workspace.interactive.confirm', arguments: { confirmation: 'I_CONFIRM_INTERACTIVE_WRITES' },
      } })}\n`);
      expect((await nextLine(child.stdout)).result).toMatchObject({ isError: false, structuredContent: { enabled: true } });

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
        name: 'multimodal.video.request',
        arguments: { prompt: '突出轻便与通勤收纳', output: 'script', context_json: JSON.stringify({ product: { id: 'product_local', version: '3' }, brand: { id: 'brand_local', version: '2' }, rules: [] }), idempotency_key: 'video-script-local-01' },
      } })}\n`);
      const response = await nextLine(child.stdout);
      expect(response.result).toMatchObject({
        isError: false,
        structuredContent: {
          candidate_only: true,
          publishable: false,
          execution: { status: 'completed', simulated: true, providerExecuted: false },
          plan: { title: '通勤轻量商品视频脚本' },
        },
      });
      expect(response.result.structuredContent.rendering).toBeUndefined();
      expect(received.map(call => call.method)).toEqual(['workspace.interactive.confirm', 'multimodal.video.request']);
      expect(received[1]?.params).toMatchObject({
        output: 'script',
        idempotency_key: 'video-script-local-01',
        workspace_id: 'ws_video_script_route',
      });
    } finally {
      child.kill();
      await once(child, 'exit').catch(() => undefined);
      upstream.close();
      await once(upstream, 'close').catch(() => undefined);
    }
  }, 5_000);
});
