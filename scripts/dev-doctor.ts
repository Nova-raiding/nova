import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { composeServiceHealth, parseComposeServiceStates, releaseReadiness } from './dev-doctor-runtime.js'

type Level = 'pass' | 'warn' | 'fail'
type Check = { id: string; level: Level; message: string; next?: string }

const args = new Set(process.argv.slice(2))
const production = args.has('--production')
const json = args.has('--json')
const checks: Check[] = []
const add = (id: string, level: Level, message: string, next?: string) => checks.push({ id, level, message, ...(next && level !== 'pass' ? { next } : {}) })
const run = (command: string, commandArgs: string[] = []) => spawnSync(command, commandArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const commandReady = (command: string, commandArgs: string[] = []) => run(command, commandArgs).status === 0
const root = process.cwd()

const nodeMajor = Number(process.versions.node.split('.')[0])
add('node', nodeMajor >= 22 ? 'pass' : 'fail', `Node ${process.versions.node}`, nodeMajor >= 22 ? undefined : '安装 Node 22+；旧 Node/ICU 组合不受支持。')
add('npm', commandReady('npm', ['--version']) ? 'pass' : 'fail', commandReady('npm', ['--version']) ? `npm ${run('npm', ['--version']).stdout.trim()}` : 'npm 不可用', '安装 package.json 指定的 npm。')

const git = run('git', ['rev-parse', '--is-inside-work-tree'])
add('git_worktree', git.status === 0 && git.stdout.trim() === 'true' ? 'pass' : production ? 'fail' : 'warn', git.status === 0 ? 'Git worktree 可用' : '当前目录不是 Git worktree', '恢复 Git clone/worktree 后才能生成可审计 release 和回滚。')

const dockerReady = commandReady('docker', ['info'])
add('docker', dockerReady ? 'pass' : 'fail', dockerReady ? 'Docker daemon 可用' : 'Docker daemon 不可用', '启动 Docker Desktop 或兼容 daemon。')
const composeReady = dockerReady && commandReady('docker', ['compose', 'version'])
add('docker_compose', composeReady ? 'pass' : 'fail', composeReady ? 'Docker Compose 可用' : 'Docker Compose 不可用', '安装 Docker Compose v2。')
const buildxReady = dockerReady && commandReady('docker', ['buildx', 'version'])
add('docker_buildx', buildxReady ? 'pass' : production ? 'fail' : 'warn', buildxReady ? 'Docker buildx 可用' : 'Docker buildx 缺失（本地可回退，生产镜像门禁阻断）', '安装 buildx 并验证多架构/不可变 digest 构建。')

const requiredFiles = ['package-lock.json', 'infra/local/docker-compose.yml', 'apps/ops-console/vite.config.ts', 'apps/plugin/.codex-plugin/plugin.json']
for (const file of requiredFiles) add(`file:${file}`, existsSync(resolve(root, file)) ? 'pass' : 'fail', existsSync(resolve(root, file)) ? `${file} 存在` : `${file} 缺失`)

const playwrightReady = [
  resolve(root, 'node_modules/@playwright/test/package.json'),
  resolve(root, 'dogfood/chatgpt-all-functions/node_modules/@playwright/test/package.json'),
].some(existsSync)
let chromeReady = false
for (const path of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium']) {
  try { accessSync(path, constants.X_OK); chromeReady = true; break } catch { /* try next known path */ }
}
add('browser_runner', playwrightReady && chromeReady ? 'pass' : 'warn', playwrightReady && chromeReady ? 'Playwright QA runner 与 Chrome 可用' : '浏览器 QA runner 或 Chrome 未就绪', '安装受控浏览器 runner 后再执行真实 UI 验收。')

let containerEnv = new Set<string>()
if (dockerReady) {
  const container = run('docker', ['compose', '-f', 'infra/local/docker-compose.yml', 'ps', '-q', 'api']).stdout.trim()
  if (container) {
    const inspected = run('docker', ['inspect', container, '--format', '{{json .Config.Env}}'])
    if (inspected.status === 0) {
      try { containerEnv = new Set((JSON.parse(inspected.stdout.trim()) as string[]).filter(item => item.slice(item.indexOf('=') + 1).trim()).map(item => item.split('=')[0]!)) } catch { /* report missing below */ }
    }
  }
}
const relayNames = ['MODEL_RELAY_BASE_URL', 'MODEL_RELAY_API_KEY', 'AI_MODEL', 'IMAGE_MODEL', 'IMAGE_EDIT_MODEL', 'OCR_MODEL', 'VIDEO_MODEL']
const relayReady = relayNames.every(name => Boolean(process.env[name]) || containerEnv.has(name))
add('model_relay', relayReady ? 'pass' : production ? 'fail' : 'warn', relayReady ? '业务模型中转配置存在（值已隐藏）' : '业务模型中转配置不完整', '通过 Secret Manager/环境合同注入七项 relay 配置；不要复制密钥到仓库。')
const identitySessionReady = Boolean(process.env.SESSION_ID_HASH_SECRET) || containerEnv.has('SESSION_ID_HASH_SECRET')
add('identity_session_hash', identitySessionReady ? 'pass' : production ? 'fail' : 'warn', identitySessionReady ? '平台身份会话指纹密钥已注入（值已隐藏）' : '平台身份会话指纹密钥未注入', '通过 Secret Manager 注入独立 SESSION_ID_HASH_SECRET；不得复用 OIDC 或 API token。')
const hostRelayReady = commandReady('npm', ['run', 'codex:relay:validate', '--silent'])
add('host_model_relay', hostRelayReady ? 'pass' : production ? 'fail' : 'warn', hostRelayReady ? '宿主 Codex 中转合同有效（值已隐藏）' : '宿主 Codex 中转合同未就绪；容器配置不代表宿主可调用', '按 ~/.codex/config.toml 中 provider 的 env_key 注入宿主密钥，并确认 model_provider 指向同一 provider；随后运行 npm run codex:relay:validate。')

const opsApiBaseReady = process.env.VITE_API_BASE === '/api' || Boolean(process.env.VITE_API_BASE)
add('ops_api_base', opsApiBaseReady ? 'pass' : 'warn', opsApiBaseReady ? 'VITE_API_BASE 已配置' : '当前 shell 未设置 VITE_API_BASE；npm run dev:ops-console 会自动使用 /api', '手工启动 Ops Console 时设置 VITE_API_BASE=/api。')

const productionConfig = process.env.PRODUCTION_CONFIG_PATH?.trim()
const productionConfigPath = productionConfig ? resolve(root, productionConfig) : ''
const productionConfigReady = Boolean(productionConfigPath && existsSync(productionConfigPath) && !/example/iu.test(productionConfigPath) && !/REPLACE_ME|SET_[A-Z_]+|example\.com/iu.test(readFileSync(productionConfigPath, 'utf8')))
add('production_config', productionConfigReady ? 'pass' : production ? 'fail' : 'warn', productionConfigReady ? '显式生产配置路径存在' : '未提供非示例 PRODUCTION_CONFIG_PATH', '渲染真实生产配置并运行 npm run infra:launch-preflight。')

if (composeReady) {
  const compose = run('docker', ['compose', '-f', 'infra/local/docker-compose.yml', 'ps', '--format', 'json'])
  const rows = compose.status === 0 ? parseComposeServiceStates(compose.stdout) : []
  const requiredServices = [
    'api', 'api-replica', 'worker-sync', 'worker-generation', 'worker-publish',
    'worker-reconcile', 'worker-automation', 'worker-scan', 'postgres', 'redis', 'ui', 'ops-ui', 'clamav',
  ]
  for (const service of requiredServices) {
    const state = composeServiceHealth(rows, service)
    const level: Level = state.healthy ? 'pass' : state.present || production ? 'fail' : 'warn'
    add(`container:${service}`, level, `${service}: ${state.detail}`, `重建并启动 ${service}，确认迁移尾、镜像源码和依赖健康后重试。`)
  }
}

for (const [id, url] of [['api', 'http://127.0.0.1:8787/healthz'], ['api_ready', 'http://127.0.0.1:8787/readyz'], ['merchant_ui', 'http://127.0.0.1:18081/'], ['ops_ui', 'http://127.0.0.1:18082/']] as const) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
    add(`runtime:${id}`, response.ok ? 'pass' : 'warn', `${id} ${url} -> HTTP ${response.status}`)
  } catch { add(`runtime:${id}`, 'warn', `${id} ${url} 未运行`, id === 'ops_ui' ? '运行 npm run dev:ops-console。' : '运行 npm run dev:stack。') }
}

try {
  const response = await fetch('http://127.0.0.1:8787/releasez', { signal: AbortSignal.timeout(1500) })
  const payload = await response.json() as unknown
  const releaseReady = releaseReadiness(payload)
  const ready = response.ok && releaseReady === true
  add('runtime:release', ready ? 'pass' : production ? 'fail' : 'warn', `releasez -> HTTP ${response.status}, ready=${String(releaseReady)}`, '注入与当前不可变发布一致的版本、迁移、图像 digest 和证据元数据。')
} catch {
  add('runtime:release', production ? 'fail' : 'warn', 'releasez 未运行或返回无效 JSON', '启动 API 并确认 /releasez 可达。')
}

const summary = { mode: production ? 'production' : 'local', passed: checks.filter(item => item.level === 'pass').length, warnings: checks.filter(item => item.level === 'warn').length, failures: checks.filter(item => item.level === 'fail').length, checks }
if (json) console.log(JSON.stringify(summary, null, 2))
else {
  console.log(`Developer doctor (${summary.mode}): ${summary.passed} pass / ${summary.warnings} warn / ${summary.failures} fail`)
  for (const check of checks) console.log(`${check.level.toUpperCase().padEnd(4)} ${check.id}: ${check.message}${check.next ? `\n     -> ${check.next}` : ''}`)
}
if (summary.failures) process.exitCode = 1
