import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('./image-local-edit.html', import.meta.url), 'utf8');

describe('图片局部编辑坐标输入合同', () => {
  it('空值保留当前画布区域，并在请求构造前聚焦对应无效坐标', () => {
    for (const id of ['rectX', 'rectY', 'rectW', 'rectH']) {
      const input = html.match(new RegExp(`<input id="${id}"[^>]*>`))?.[0] ?? '';
      expect(input).toContain('required');
    }

    const inputStart = html.indexOf("for(const [id,key] of [['rectX'");
    const inputEnd = html.indexOf("for(const id of ['editableJson'", inputStart);
    expect(inputStart).toBeGreaterThanOrEqual(0);
    expect(inputEnd).toBeGreaterThan(inputStart);
    const inputHandler = html.slice(inputStart, inputEnd);
    expect(inputHandler).toContain("if(event.target.value.trim()==='')return");

    const buildStart = html.indexOf('function buildRequest(){');
    const buildEnd = html.indexOf('function clearFieldError(', buildStart);
    expect(buildStart).toBeGreaterThanOrEqual(0);
    expect(buildEnd).toBeGreaterThan(buildStart);
    const buildRequest = html.slice(buildStart, buildEnd);
    expect(buildRequest).toContain("[['rectX','X'],['rectY','Y'],['rectW','宽'],['rectH','高']]");
    expect(buildRequest).toContain('!field.value.trim()||!field.validity.valid');
    expect(buildRequest).toContain('throw validationError(id,`区域${label}必须填写有效数值，并符合标注范围。`)');
    expect(buildRequest.indexOf('!field.value.trim()||!field.validity.valid')).toBeLessThan(buildRequest.indexOf('const issue=regionIssue()'));
  });
});
