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

describe('workspace.invitations.list MCP contract', () => {
  it('keeps incoming invitation lookup read-only and workspace scoped', async () => {
    const forwarded: Array<{ method?: string; body?: { method?: string; params?: Record<string, unknown> } }> = [];
    let denyNextRequest = false;
    const upstream = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        forwarded.push({ method: request.method, body: JSON.parse(body) });
        response.setHeader('content-type', 'application/json');
        if (denyNextRequest) {
          denyNextRequest = false;
          response.end(JSON.stringify({ data: { error: { code: 'PERMISSION_DENIED', message: 'Invitation access denied' } }, error: null }));
          return;
        }
        response.end(JSON.stringify({ data: { result: { invitations: [{ member_id: 'invite-local', revision: 2 }], unread_count: 1 } }, error: null }));
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
        MERCHANT_WORKSPACE_ID: 'ws_invitation_contract',
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
      const tool = listed.result.tools.find((candidate: { name: string }) => candidate.name === 'workspace.invitations.list');
      expect(tool).toMatchObject({
        description: expect.stringContaining('当前登录账号'),
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      });

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'workspace.invitations.list', arguments: {} } })}\n`);
      const result = await nextLine(child.stdout);
      expect(result.result.isError).toBe(false);
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0]).toMatchObject({
        method: 'POST',
        body: { method: 'workspace.invitations.list', params: { workspace_id: 'ws_invitation_contract' } },
      });
      expect(result.result.structuredContent).toMatchObject({ unread_count: 1 });

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'workspace.invitations.list', arguments: { target_workspace_id: 'ws_someone_else' } } })}\n`);
      const malformed = await nextLine(child.stdout);
      expect(malformed.result.isError).toBe(true);
      expect(malformed.result.structuredContent.code).toBe('TOOL_ARGUMENTS_INVALID');
      expect(forwarded).toHaveLength(1);

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'workspace.invitations.list', arguments: { workspace_id: 'ws_someone_else' } } })}\n`);
      const wrongWorkspace = await nextLine(child.stdout);
      expect(wrongWorkspace.result.isError).toBe(true);
      expect(wrongWorkspace.result.structuredContent.code).toBe('WORKSPACE_SCOPE_MISMATCH');
      expect(forwarded).toHaveLength(1);

      denyNextRequest = true;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'workspace.invitations.list', arguments: {} } })}\n`);
      const denied = await nextLine(child.stdout);
      expect(denied.result.isError).toBe(true);
      expect(denied.result.structuredContent.code).toBe('PERMISSION_DENIED');
      expect(forwarded).toHaveLength(2);
    } finally {
      child.kill();
      await once(child, 'exit').catch(() => undefined);
      upstream.close();
      await once(upstream, 'close').catch(() => undefined);
    }
  }, 5_000);
});
