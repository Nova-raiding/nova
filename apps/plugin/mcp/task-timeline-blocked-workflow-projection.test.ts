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

describe('task.timeline blocked workflow projection', () => {
  it('shows the server reason and safe next action for a blocked workflow', async () => {
    const upstream = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: { result: {
        events: [{ type: 'generation_blocked', message: '缺少已确认的商品规格' }],
        workflows: [{
          kind: 'generation',
          resource_id: 'internal-job-42',
          status: { internal_state: 'blocked_missing_facts', user_state: '缺少已确认的商品规格', terminal: true },
          progress: { known: false, label: '等待补充商品事实' },
          next_action: { method: 'task.answer', label: '补充商品规格', allowed: true, reason: '商品规格尚未确认' },
          recovery: { retryable: false, resume_method: 'task.resume', reconciliation_required: false },
        }],
      } }, error: null }));
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
        MERCHANT_WORKSPACE_ID: 'ws_task_timeline_projection',
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
        name: 'task.timeline', arguments: { task_id: 'task_local' },
      } })}\n`);
      const result = await nextLine(child.stdout);
      expect(result.result.isError).toBe(false);
      expect(result.result.structuredContent.merchant_status).toMatchObject({
        state: 'blocked_missing_facts',
        label: '缺少已确认的商品规格',
        next_action: { label: '补充商品规格', allowed: true },
        recovery: { retryable: false },
      });
      expect(result.result.content[0].text).toContain('缺少已确认的商品规格');
      expect(result.result.content[0].text).toContain('补充商品规格');
    } finally {
      child.kill();
      await once(child, 'exit').catch(() => undefined);
      upstream.close();
      await once(upstream, 'close').catch(() => undefined);
    }
  }, 5_000);
});
