import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const bridge = readFileSync(new URL('./bridge.mjs', import.meta.url), 'utf8');

describe('发布确认 MCP App 门禁合同', () => {
  it('发布按钮需显式勾选并先取得当前会话确认票据', () => {
    const start = bridge.indexOf('function taskDecisionUiHtml(kind)');
    const end = bridge.indexOf('const creativeChoiceUiHtml', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const component = bridge.slice(start, end);

    expect(component).toContain("primary.disabled=kind==='publish'?!ackInput.checked:!selected");
    expect(component).toContain("ackInput.addEventListener('change',updatePrimary)");
    expect(component).toContain("if(primary.disabled)return");

    const sessionConfirm = component.indexOf("window.openai.callTool('workspace.interactive.confirm'");
    const publishConfirm = component.indexOf("await callTool('publish.confirm'");
    expect(sessionConfirm).toBeGreaterThanOrEqual(0);
    expect(publishConfirm).toBeGreaterThan(sessionConfirm);
    expect(component).toContain('confirmation_ticket_nonce_hash');
    expect(component).toContain('confirmation_ticket_intent_hash');
  });
});
