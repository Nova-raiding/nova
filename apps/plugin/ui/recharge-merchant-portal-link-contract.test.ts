import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('./recharge.html', import.meta.url), 'utf8');

describe('套餐目录商家后台入口合同', () => {
  it('只为已批准、可执行、公开套餐显示安全外链，且不直接发起支付', () => {
    const start = html.indexOf('function catalogHtml(value)');
    const end = html.indexOf('async function catalog()', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const catalogRenderer = html.slice(start, end);

    expect(catalogRenderer).toContain("item?.lifecycle === \"approved\"");
    expect(catalogRenderer).toContain('item?.executable === true');
    expect(catalogRenderer).toContain('item?.visibility === "public"');
    expect(catalogRenderer).toContain('data-open-merchant-portal="true"');

    const startHandler = html.indexOf('button.onclick = () => {', end);
    const endHandler = html.indexOf('};', startHandler);
    expect(startHandler).toBeGreaterThan(end);
    const clickHandler = html.slice(startHandler, endHandler);
    expect(clickHandler).toContain('window.open("https://yxsona.com", "_blank", "noopener,noreferrer")');
    expect(clickHandler).not.toContain('callTool(');
    expect(clickHandler).not.toMatch(/(?:billing\.recharge\.create|commercial\.checkout\.create)/u);
  });
});
