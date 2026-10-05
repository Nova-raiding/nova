import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

async function callTask(method: string, result: any) {
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: { result }, error: null })) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test HTTP server unavailable')
  const child = spawn(process.execPath, [fileURLToPath(new URL('./bridge.mjs', import.meta.url))], {
    env: { ...process.env, NODE_ENV: 'test', DEPLOY_ENV: '${DEPLOY_ENV}', MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`,
      MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_TOKEN_SOURCE: 'environment', MERCHANT_MCP_TOKEN: '', MERCHANT_MCP_REFRESH_TOKEN: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: child.stdout }); const iterator = lines[Symbol.asyncIterator]()
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name: 'workspace.interactive.confirm', arguments: { confirmation: 'I_CONFIRM_INTERACTIVE_WRITES' } } }) + '\n')
    await iterator.next()
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: method, arguments: {
      task_id: 'task_source', ...(method === 'task.answer' ? { answers_json: '{"placement":"纯文本"}', expected_version: '1' } : {}),
    } } }) + '\n')
    const line = await iterator.next(); return JSON.parse(line.value!).result
  } finally { lines.close(); child.kill(); server.close(); await once(server, 'close') }
}

describe('fresh task clone and saved answer text', () => {
  it.each(['ready', 'draft', 'cross_platform', 'unknown', 'same_id', 'stale_content', 'stale_promotion', 'missing_mode', 'wrong_reload', 'old_plan', 'false_ok'])('only confirms an actual fresh clone: %s', async variant => {
    const result: any = { task: { id: 'task_copy', state: 'ready_for_direction', version: 1 }, sourceTaskId: 'task_source',
      copyMode: 'same_platform_fresh_task', ruleReloadRequired: false, staleContentCopied: false, stalePromotionCopied: false }
    if (variant === 'draft') result.task.state = 'draft'
    if (variant === 'cross_platform') { result.copyMode = 'cross_platform_fresh_task'; result.ruleReloadRequired = true }
    if (variant === 'unknown') { result.task.state = 'unknown'; result.status = 'success' }
    if (variant === 'same_id') result.task.id = result.sourceTaskId
    if (variant === 'stale_content') result.staleContentCopied = true
    if (variant === 'stale_promotion') result.stalePromotionCopied = true
    if (variant === 'missing_mode') delete result.copyMode
    if (variant === 'wrong_reload') result.ruleReloadRequired = true
    if (variant === 'old_plan') result.task.productionPlan = { id: 'old_plan' }
    if (variant === 'false_ok') result.ok = false
    const response = await callTask('task.clone', result)
    expect(response.isError).toBe(false)
    const text = response.content[0].text
    if (['ready', 'draft', 'cross_platform'].includes(variant)) {
      expect(text).toContain('已创建新的草稿任务，原任务保持不变')
      expect(text).toContain('本次复制没有生成内容')
      if (variant === 'draft') expect(text).toContain('补充待确认输入')
      if (variant === 'cross_platform') expect(text).toContain('规则仍需重新加载与核验')
    } else { expect(text).not.toContain('已创建新的草稿任务'); expect(text).not.toContain('操作已完成') }
    expect(response.structuredContent.sourceTaskId).toBe(result.sourceTaskId)
  })

  it.each(['ready', 'draft', 'selected', 'unknown', 'wrong_snapshot', 'missing_answers', 'false_ok', 'failed_status'])('only confirms persisted task inputs: %s', async variant => {
    const result: any = { id: 'task_source', version: 2, state: 'ready_for_direction', inputSnapshotId: 'task:task_source:v2', answers: { placement: '纯文本' }, missingQuestions: [] }
    if (variant === 'draft') { result.state = 'draft'; result.missingQuestions = [{ kind: 'blocking', id: 'facts' }] }
    if (variant === 'selected') result.state = 'direction_selected'
    if (variant === 'unknown') { result.state = 'unknown'; result.status = 'success' }
    if (variant === 'wrong_snapshot') result.inputSnapshotId = 'task:task_other:v2'
    if (variant === 'missing_answers') delete result.answers
    if (variant === 'false_ok') result.ok = false
    if (variant === 'failed_status') result.status = 'failed'
    const response = await callTask('task.answer', result)
    expect(response.isError).toBe(false)
    const text = response.content[0].text
    if (['ready', 'draft', 'selected'].includes(variant)) {
      expect(text).toContain('任务输入已保存')
      expect(text).toContain('本次保存没有生成内容')
      if (variant === 'draft') expect(text).toContain('仍有待确认输入')
      if (variant === 'ready') expect(text).toContain('下一步可准备并选择制作方向')
    } else { expect(text).not.toContain('任务输入已保存'); expect(text).not.toContain('操作已完成') }
    expect(response.structuredContent.version).toBe(result.version)
  })
})
