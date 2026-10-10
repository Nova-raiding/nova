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

describe('stdio MCP resource URI dispatch', () => {
  it('rejects an unknown resource URI instead of returning an unrelated UI', async () => {
    const child = spawn(process.execPath, [bridge.pathname], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DEPLOY_ENV: 'local_desktop',
        MERCHANT_MCP_BASE_URL: 'http://127.0.0.1:9',
        MERCHANT_WORKSPACE_ID: 'ws_resource_contract',
        MERCHANT_MCP_TOKEN: '',
        MERCHANT_MCP_REFRESH_TOKEN: '',
        MERCHANT_MCP_TOKEN_SOURCE: 'environment',
        MERCHANT_STRICT_AUTH: 'true',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/read',
        params: { uri: 'ui://merchant-marketing/does-not-exist-v1.html' },
      })}\n`);
      const response = await nextLine(child.stdout);
      expect(response.error).toMatchObject({ code: -32602 });
      expect(response.error.message).toContain('未找到资源');
      expect(response.result).toBeUndefined();
    } finally {
      child.kill();
      await once(child, 'exit').catch(() => undefined);
    }
  }, 5_000);
});
