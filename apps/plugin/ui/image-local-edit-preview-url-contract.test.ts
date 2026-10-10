import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('./image-local-edit.html', import.meta.url), 'utf8');

describe('图片局部编辑预览地址输入合同', () => {
  it('只接受受限图片地址并在拒绝时清除旧预览', () => {
    const start = html.indexOf('function loadImage(){');
    const end = html.indexOf('function request(', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const loader = html.slice(start, end);
    const match = loader.match(/const allowed=(\/(?:\\.|[^/])+\/[a-z]+)\.test\(value\)/u);
    expect(match?.[1]).toBeDefined();
    const literal = match?.[1] ?? '';
    const lastSlash = literal.lastIndexOf('/');
    const allowlist = new RegExp(literal.slice(1, lastSlash), literal.slice(lastSlash + 1));

    for (const value of [
      'https://cdn.example.test/product.png',
      'blob:https://app.example.test/local-image',
      'data:image/png;base64,aGVsbG8=',
      'data:image/jpeg;base64,aGVsbG8=',
      'data:image/webp;base64,aGVsbG8=',
    ]) expect(allowlist.test(value)).toBe(true);
    for (const value of [
      'http://127.0.0.1/private.png',
      '//cdn.example.test/product.png',
      'javascript:alert(1)',
      'data:image/svg+xml;base64,PHN2Zz4=',
    ]) expect(allowlist.test(value)).toBe(false);
    expect(loader).toContain("if(!allowed){$('sourceImage').removeAttribute('src');return}");
  });
});
