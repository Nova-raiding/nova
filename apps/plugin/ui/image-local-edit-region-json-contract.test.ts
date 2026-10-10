import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('./image-local-edit.html', import.meta.url), 'utf8');

describe('图片局部编辑区域 JSON 字段合同', () => {
  it('编辑区域与保护区域必须是数组，并在 Host 调用前拒绝非法值', () => {
    for (const id of ['editableJson', 'protectedJson']) {
      expect(html).toMatch(new RegExp(`<textarea id="${id}"`));
    }

    const parserStart = html.indexOf('function parseJson(');
    const parserEnd = html.indexOf('function validationError(', parserStart);
    expect(parserStart).toBeGreaterThanOrEqual(0);
    expect(parserEnd).toBeGreaterThan(parserStart);
    expect(html.slice(parserStart, parserEnd)).toContain('Array.isArray(parsed)?parsed:fallback');

    const buildStart = html.indexOf('function buildRequest(){');
    const buildEnd = html.indexOf('function clearFieldError(', buildStart);
    expect(buildStart).toBeGreaterThanOrEqual(0);
    expect(buildEnd).toBeGreaterThan(buildStart);
    const buildRequest = html.slice(buildStart, buildEnd);
    expect(buildRequest).toContain("parseJson(fieldValue('editableJson'),null)");
    expect(buildRequest).toContain("parseJson(fieldValue('protectedJson'),null)");
    expect(buildRequest).toContain("validationError('editableJson'");
    expect(buildRequest).toContain("validationError('protectedJson'");

    const submitStart = html.indexOf("$('editorForm').addEventListener('submit'");
    const submitEnd = html.indexOf('function hydrate(', submitStart);
    expect(submitStart).toBeGreaterThanOrEqual(0);
    expect(submitEnd).toBeGreaterThan(submitStart);
    const submit = html.slice(submitStart, submitEnd);
    expect(submit.indexOf('payload=buildRequest()')).toBeLessThan(submit.indexOf("callTool('multimodal.image.edit'"));
    expect(submit).toContain('catch(error){showError(error.message||');
    expect(submit).toContain('return}const args=');
  });
});
