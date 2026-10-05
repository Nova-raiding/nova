import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const methods = ['task.select_direction', 'task.plan.confirm'] as const
const variants = ['success', 'unknown_state', 'false_ok', 'failed_status', 'missing_plan', 'wrong_task', 'wrong_direction', 'invalid_version', 'missing_confirmation'] as const

describe('task state success text on the actual stdio bridge', () => {
  for (const method of methods) {
    it.each(variants)(`${method} respects the returned task/plan evidence: %s`, async variant => {
      const result: any = {
        id: 'task_state_test', state: method === 'task.select_direction' ? 'direction_selected' : 'plan_confirmed',
        version: 6, selectedDirectionId: 'A-v1', candidateOnly: true,
        productionPlan: { id: 'plan:task_state_test:v5', taskId: 'task_state_test', version: 2, directionId: 'A-v1',
          confirmedAt: '2026-10-05T03:15:16.096Z', confirmedBy: 'test_actor' },
      }
      if (variant === 'unknown_state') result.state = 'unknown'
      if (variant === 'false_ok') result.ok = false
      if (variant === 'failed_status') result.status = 'failed'
      if (variant === 'missing_plan') delete result.productionPlan
      if (variant === 'wrong_task') result.productionPlan.taskId = 'task_other'
      if (variant === 'wrong_direction') result.productionPlan.directionId = 'B-v1'
      if (variant === 'invalid_version') result.version = 0
      if (variant === 'missing_confirmation') delete result.productionPlan.confirmedAt
      const server = createServer((_request, response) => {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ data: { result }, error: null }))
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('test HTTP server unavailable')
      const child = spawn(process.execPath, [fileURLToPath(new URL('./bridge.mjs', import.meta.url))], {
        env: { ...process.env, NODE_ENV: 'test', DEPLOY_ENV: '${DEPLOY_ENV}',
          MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_task_test',
          MERCHANT_MCP_TOKEN_SOURCE: 'environment', MERCHANT_MCP_TOKEN: 'test-fixture-token', MERCHANT_MCP_REFRESH_TOKEN: '', MERCHANT_ALLOW_FIXTURE_FALLBACK: 'true' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const lines = createInterface({ input: child.stdout })
      const iterator = lines[Symbol.asyncIterator]()
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: {
          name: 'workspace.interactive.confirm', arguments: { confirmation: 'I_CONFIRM_INTERACTIVE_WRITES' },
        } }) + '\n')
        await iterator.next()
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: method,
          arguments: { task_id: 'task_state_test', expected_version: '5', ...(method === 'task.select_direction' ? { direction_id: 'A-v1' } : {}) },
        } }) + '\n')
        const line = await iterator.next()
        const response = JSON.parse(line.value!)
        expect(response.result.isError).toBe(false)
        const text = response.result.content[0].text
        const prefix = method === 'task.select_direction' ? '制作方向已选择，制作方案已准备。' : '制作方案已确认。'
        const success = variant === 'success' || (variant === 'missing_confirmation' && method === 'task.select_direction')
        if (success) {
          expect(text).toContain(prefix)
          expect(text).not.toContain('状态尚未确认')
          if (method === 'task.plan.confirm') expect(text).toContain('本次确认不代表内容已生成、审核或发布')
          else expect(text).toContain('本次选择不会生成内容')
        } else expect(text).not.toContain(prefix)
        expect(response.result.structuredContent.state).toBe(result.state)
        expect(response.result.structuredContent.version).toBe(result.version)
        expect(response.result.structuredContent.candidateOnly).toBe(true)
      } finally {
        lines.close()
        child.kill()
        server.close()
        await once(server, 'close')
      }
    })
  }
})
