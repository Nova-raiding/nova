import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('./image-local-edit.html', import.meta.url), 'utf8');

describe('图片编辑候选回执文本插入合同', () => {
  it('将服务端候选 ID 与模型版本按纯文本渲染', () => {
    const start = html.indexOf('function renderCandidate(data,submitted)');
    const end = html.indexOf("$('editorForm').addEventListener('submit'", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const renderCandidate = html.slice(start, end);
    expect(renderCandidate).toContain("$('candidateId').textContent=result.id");
    expect(renderCandidate).toContain("$('candidateModel').textContent=result.modelVersion");
    expect(renderCandidate).not.toContain("$('candidateId').innerHTML");
    expect(renderCandidate).not.toContain("$('candidateModel').innerHTML");
  });
});
