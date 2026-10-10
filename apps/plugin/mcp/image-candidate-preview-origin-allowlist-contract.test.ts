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

describe('image candidate preview origin allowlist', () => {
  it('does not surface external or parser-escaping candidate URLs', async () => {
    const urls = ['https://untrusted.example/tracker.png', '/\\evil.example/x'];
    const upstream = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        const call = JSON.parse(body) as { params?: { job_id?: string } };
        const jobId = call.params?.job_id ?? 'job_image_origin_local';
        const url = jobId === 'job_backslash_origin_local' ? urls[1] : urls[0];
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ data: { result: {
          job_id: jobId,
          images: ['data:image/png;base64,aW1hZ2U='],
          image_urls: [url],
          selection_tickets: [{ visual_ref: 'visual_local', nonce_hash: 'a'.repeat(64), intent_hash: 'b'.repeat(64), expires_at: '2099-01-01T00:00:00.000Z' }],
          job: { revision: 3, state: 'succeeded', archiveState: 'archived', candidates: [
            { visualRef: 'visual_local', assetId: 'asset_local', ordinal: 1, scanStatus: 'clean', reviewStatus: 'passed' },
          ] },
        } }, error: null }));
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
        MERCHANT_ASSET_RESOURCE_DOMAINS: JSON.stringify(['https://assets.safe.example']),
        MERCHANT_WORKSPACE_ID: 'ws_image_origin_allowlist',
        MERCHANT_MCP_TOKEN: 'local-test-token',
        MERCHANT_MCP_REFRESH_TOKEN: '',
        MERCHANT_MCP_TOKEN_SOURCE: 'environment',
        MERCHANT_STRICT_AUTH: 'true',
        MERCHANT_MCP_WRITE_ENABLED: 'false',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      for (const [index, jobId] of ['job_https_origin_local', 'job_backslash_origin_local'].entries()) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: {
          name: 'catalog.image.get', arguments: { job_id: jobId },
        } })}\n`);
        const response = await nextLine(child.stdout);
        expect(response.result.isError).toBe(false);
        expect(response.result.structuredContent.candidate_state).toMatchObject({ state: 'ready', presentation: 'native_image' });
        expect(response.result.structuredContent).not.toHaveProperty('image_urls');
        expect(response.result._meta?.['merchant/candidateImages']).toEqual([]);
        expect(JSON.stringify(response.result)).not.toContain('untrusted.example');
        expect(JSON.stringify(response.result)).not.toContain('evil.example');
        expect(response.result.content).toContainEqual({ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' });
      }
    } finally {
      child.kill();
      await once(child, 'exit').catch(() => undefined);
      upstream.close();
      await once(upstream, 'close').catch(() => undefined);
    }
  }, 5_000);
});
