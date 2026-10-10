import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('./image-local-edit.html', import.meta.url), 'utf8');

describe('图片局部编辑键盘选区合同', () => {
  it('方向键移动选区，Shift 加方向键调整尺寸，并阻止页面滚动', () => {
    const start = html.indexOf("$('selection').addEventListener('keydown'");
    const end = html.indexOf("for(const [id,key] of [['rectX'", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const keyHandler = html.slice(start, end);
    expect(keyHandler).toContain("['ArrowLeft','ArrowRight','ArrowUp','ArrowDown']");
    expect(keyHandler).toContain('const step=event.altKey ? .05 : .01');
    expect(keyHandler).toContain('if(event.shiftKey)');
    expect(keyHandler).toContain("if(event.key==='ArrowLeft')rect.width-=step");
    expect(keyHandler).toContain("if(event.key==='ArrowRight')rect.width+=step");
    expect(keyHandler).toContain("if(event.key==='ArrowUp')rect.height-=step");
    expect(keyHandler).toContain("if(event.key==='ArrowDown')rect.height+=step");
    expect(keyHandler).toContain("if(event.key==='ArrowLeft')rect.x-=step");
    expect(keyHandler).toContain("if(event.key==='ArrowRight')rect.x+=step");
    expect(keyHandler).toContain("if(event.key==='ArrowUp')rect.y-=step");
    expect(keyHandler).toContain("if(event.key==='ArrowDown')rect.y+=step");
    expect(keyHandler).toContain('syncRect()');
    expect(keyHandler).toContain('event.preventDefault()');
  });
});
