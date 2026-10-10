import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('./image-local-edit.html', import.meta.url), 'utf8');

describe('图片局部编辑复制请求按钮契约', () => {
  it('从当前表单构造 JSON、展示复制结果且不调用 Host', () => {
    const start = html.indexOf("$('copy').addEventListener('click'");
    const end = html.indexOf("$('reset').addEventListener('click'", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const handler = html.slice(start, end);
    expect(handler).toContain('buildRequest()');
    expect(handler).toContain("$('fallbackJson').value=body");
    expect(handler).toContain('await copyText(body)');
    expect(handler).toContain('请求 JSON 已复制');
    expect(handler).not.toContain('callTool(');
  });
});
