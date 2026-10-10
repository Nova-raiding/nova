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

describe('video storyboard confirmed draft contract', () => {
  it('requires current-session consent and reports storyboard as an unpublished, non-rendered candidate', async () => {
    const received: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const upstream = createServer((request, response) => {
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
              storyboard: { title: '轻量通勤商品分镜', scenes: [{ shot: 1, duration_seconds: 3, visual: '展示商品收纳细节' }] },
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
        MERCHANT_WORKSPACE_ID: 'ws_video_storyboard_local',
        MERCHANT_MCP_TOKEN: 'local-test-token',
        MERCHANT_MCP_REFRESH_TOKEN: '',
        MERCHANT_MCP_TOKEN_SOURCE: 'environment',
        MERCHANT_STRICT_AUTH: 'true',
        MERCHANT_MCP_WRITE_ENABLED: 'true',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const storyboardArguments = {
      prompt: '为已确认商品制作三镜头分镜',
      output: 'storyboard',
      context_json: JSON.stringify({ product: { id: 'product_fixture', version: '3' }, brand: { id: 'brand_fixture', version: '2' }, rules: [] }),
      idempotency_key: 'video-storyboard-local-01',
    };
    const call = async (id: number, name: string, args: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
      return nextLine(child.stdout);
    };
    try {
      const blocked = await call(1, 'multimodal.video.request', storyboardArguments);
      expect(blocked.result).toMatchObject({ isError: true, structuredContent: { code: 'INTERACTIVE_WRITE_DISABLED' } });
      expect(received).toHaveLength(0);

      expect((await call(2, 'workspace.interactive.confirm', { confirmation: 'I_CONFIRM_INTERACTIVE_WRITES' })).result)
        .toMatchObject({ isError: false, structuredContent: { enabled: true } });
      const response = await call(3, 'multimodal.video.request', storyboardArguments);
      expect(response.result).toMatchObject({
        isError: false,
        structuredContent: {
          candidate_only: true,
          publishable: false,
          execution: { status: 'completed', simulated: true, providerExecuted: false },
          storyboard: { title: '轻量通勤商品分镜' },
        },
      });
      expect(response.result.structuredContent.rendering).toBeUndefined();
      expect(received.map(item => item.method)).toEqual(['workspace.interactive.confirm', 'multimodal.video.request']);
      expect(received[1]?.params).toMatchObject({
        output: 'storyboard',
        workspace_id: 'ws_video_storyboard_local',
        idempotency_key: 'video-storyboard-local-01',
      });
    } finally {
      child.kill();
      await once(child, 'exit').catch(() => undefined);
      upstream.close();
      await once(upstream, 'close').catch(() => undefined);
    }
  }, 5_000);
});
