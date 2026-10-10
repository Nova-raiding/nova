import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chromium, type Browser, type BrowserServer } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const bridgePath = new URL('../mcp/bridge.mjs', import.meta.url)
let browser: Browser
let browserServer: BrowserServer | undefined

function nextLine(stream: NodeJS.ReadableStream): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      cleanup()
      try { resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, any>) } catch (error) { reject(error) }
    }
    const onError = (error: Error) => { cleanup(); reject(error) }
    const onEnd = () => { cleanup(); reject(new Error('bridge exited before returning the creative choice resource')) }
    const cleanup = () => {
      stream.off('data', onData)
      stream.off('error', onError)
      stream.off('end', onEnd)
    }
    stream.on('data', onData)
    stream.once('error', onError)
    stream.once('end', onEnd)
  })
}

beforeAll(async () => {
  browserServer = await chromium.launchServer({ headless: true })
  browser = await chromium.connect(browserServer.wsEndpoint())
})

afterAll(async () => {
  await browser?.close()
  await browserServer?.close()
}, 60_000)

describe('creative choice MCP UI', () => {
  it('requires a deliberate direction choice and submits only that task direction', async () => {
    const child = spawn(process.execPath, [bridgePath.pathname], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DEPLOY_ENV: 'local_desktop',
        MERCHANT_MCP_BASE_URL: 'https://merchant.example.test',
        MERCHANT_WORKSPACE_ID: 'ws_creative_choice_ui',
        MERCHANT_MCP_TOKEN: '',
        MERCHANT_MCP_REFRESH_TOKEN: '',
        MERCHANT_MCP_TOKEN_SOURCE: 'environment',
        MERCHANT_STRICT_AUTH: 'true',
        MERCHANT_MCP_WRITE_ENABLED: 'false',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const calls: Array<{ name: string; arguments: unknown }> = []
    const page = await browser.newPage()
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'ui://merchant-marketing/creative-choice-v1.html' } })}\n`)
      const resource = await nextLine(child.stdout)
      expect(resource.result.contents[0]).toMatchObject({ mimeType: 'text/html;profile=mcp-app' })
      const output = {
        directions: [
          { id: 'direction-video-proof', name: '产品细节证明', coreIdea: '用已核实细节建立信任', fitReason: '适合功能展示', copyDirection: '只使用已确认卖点', visualDirection: '近景展现真实细节', structure: ['开场', '细节', '收束'] },
          { id: 'direction-scene', name: '生活场景', coreIdea: '展示具体使用场景' },
        ],
      }
      const host = `<script>window.openai={toolInput:{task_id:'task_video_storyboard'},toolOutput:${JSON.stringify(output)},callTool:async(name,args)=>{window.__calls.push({name,arguments:args});return name==='workspace.interactive.confirm'?{isError:false,structuredContent:{enabled:true}}:{isError:false,structuredContent:{selected:true}}}};window.__calls=[];</script>`
      const html = resource.result.contents[0].text as string
      await page.setContent(html.replace('<script>', `${host}<script>`))

      const confirm = page.locator('#primary')
      expect(await confirm.isDisabled()).toBe(true)
      expect(await page.locator('#options input[type="radio"]').count()).toBe(2)
      await page.getByLabel('产品细节证明').check()
      expect(await confirm.isEnabled()).toBe(true)
      await confirm.click()
      await expect.poll(() => confirm.textContent()).toBe('已完成')
      expect(await page.evaluate(() => (window as unknown as Window & { __calls: typeof calls }).__calls)).toEqual([
        { name: 'workspace.interactive.confirm', arguments: { confirmation: 'I_CONFIRM_INTERACTIVE_WRITES' } },
        { name: 'task.select_direction', arguments: { task_id: 'task_video_storyboard', direction_id: 'direction-video-proof' } },
      ])
    } finally {
      await page.close()
      child.kill()
      await once(child, 'exit').catch(() => undefined)
    }
  }, 20_000)
})
