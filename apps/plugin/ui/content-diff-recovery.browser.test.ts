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
    const onEnd = () => { cleanup(); reject(new Error('bridge exited before returning the content diff resource')) }
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

describe('content diff recovery UI', () => {
  it('keeps the chosen version selected and allows an explicit retry after a restore failure', async () => {
    const child = spawn(process.execPath, [bridgePath.pathname], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DEPLOY_ENV: 'local_desktop',
        MERCHANT_MCP_BASE_URL: 'https://merchant.example.test',
        MERCHANT_WORKSPACE_ID: 'ws_content_diff_ui',
        MERCHANT_MCP_TOKEN: '',
        MERCHANT_MCP_REFRESH_TOKEN: '',
        MERCHANT_MCP_TOKEN_SOURCE: 'environment',
        MERCHANT_STRICT_AUTH: 'true',
        MERCHANT_MCP_WRITE_ENABLED: 'false',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const page = await browser.newPage()
    const calls: Array<{ name: string; arguments: unknown }> = []
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'ui://merchant-marketing/content-diff-v1.html' } })}\n`)
      const resource = await nextLine(child.stdout)
      expect(resource.result.contents[0]).toMatchObject({ mimeType: 'text/html;profile=mcp-app' })
      const output = {
        fromVersionId: 'version-old',
        toVersionId: 'version-new',
        changes: [{ path: 'headline', before: '旧标题', after: '新标题' }],
      }
      const host = `<script>window.openai={toolInput:{},toolOutput:${JSON.stringify(output)},callTool:async(name,args)=>{window.__calls.push({name,arguments:args});return name==='workspace.interactive.confirm'?{isError:false,structuredContent:{enabled:true}}:{isError:true,content:[{type:'text',text:'版本保留失败，请稍后重试。'}],structuredContent:{code:'API_UNAVAILABLE'}}}};window.__calls=[];</script>`
      const html = resource.result.contents[0].text as string
      await page.setContent(html.replace('<script>', `${host}<script>`))

      const primary = page.locator('#primary')
      expect(await primary.isDisabled()).toBe(true)
      await page.locator('#options input[value="version-old"]').check()
      expect(await primary.isEnabled()).toBe(true)
      await primary.click()
      await expect.poll(() => page.locator('#status').textContent()).toBe('版本保留失败，请稍后重试。')
      expect(await page.locator('#options input[value="version-old"]').isChecked()).toBe(true)
      expect(await primary.isEnabled()).toBe(true)
      expect(await page.evaluate(() => (window as unknown as Window & { __calls: typeof calls }).__calls)).toEqual([
        { name: 'workspace.interactive.confirm', arguments: { confirmation: 'I_CONFIRM_INTERACTIVE_WRITES' } },
        { name: 'content.restore', arguments: { content_version_id: 'version-old' } },
      ])
    } finally {
      await page.close()
      child.kill()
      await once(child, 'exit').catch(() => undefined)
    }
  }, 20_000)
})
