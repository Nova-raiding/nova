import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('./recharge.html', import.meta.url), 'utf8');

describe('创意点状态刷新按钮合同', () => {
  it('刷新按钮只触发 billing.status 读取，不发起账务写入', () => {
    expect(html).toContain('id="refreshStatus"');
    expect(html).toMatch(/\$\("refreshStatus"\)\.onclick\s*=\s*loadStatus/u);

    const start = html.indexOf('async function loadStatus()');
    const end = html.indexOf('function orderHtml(', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const refreshHandler = html.slice(start, end);
    expect(refreshHandler).toContain('call("billing.status")');
    expect(refreshHandler.match(/\bcall\(/gu)).toHaveLength(1);
    expect(refreshHandler).not.toMatch(/(?:billing\.recharge\.create|commercial\.checkout\.create|subscription\.change)/u);
    expect(refreshHandler).toContain('fail(e.message');
  });
});
