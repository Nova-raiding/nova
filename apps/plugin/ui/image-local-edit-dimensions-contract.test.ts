import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('./image-local-edit.html', import.meta.url), 'utf8');

describe('图片局部编辑原图尺寸字段合同', () => {
  it('宽高均要求正整数，并在构造请求时再次校验', () => {
    for (const id of ['imageWidth', 'imageHeight']) {
      const input = html.match(new RegExp(`<input id="${id}"[^>]*>`))?.[0] ?? '';
      expect(input).toContain('required');
      expect(input).toContain('type="number"');
      expect(input).toContain('min="1"');
      expect(input).toContain('step="1"');
    }

    const start = html.indexOf('function buildRequest(){');
    const end = html.indexOf('function clearFieldError(', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const buildRequest = html.slice(start, end);
    expect(buildRequest).toContain('!Number.isInteger(width)||width<1');
    expect(buildRequest).toContain('!Number.isInteger(height)||height<1');
    expect(buildRequest).toContain("validationError('imageWidth'");
    expect(buildRequest).toContain("validationError('imageHeight'");
  });
});
