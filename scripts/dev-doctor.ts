import { accessSync, constants, existsSync, readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { commercialRuntimeReadiness, composeServiceHealth, parseComposeServiceStates, releaseReadiness } from './dev-doctor-runtime.js'

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
const containerEnvironmentNames = (service: string) => {
  const names = new Set<string>()
  if (!dockerReady) return names
  const container = run('docker', ['compose', '-f', 'infra/local/docker-compose.yml', 'ps', '-q', service]).stdout.trim()
  if (!container) return names
  const inspected = run('docker', ['inspect', container, '--format', '{{json .Config.Env}}'])
  if (inspected.status !== 0) return names
  try {
    for (const item of JSON.parse(inspected.stdout.trim()) as string[]) {
      if (item.slice(item.indexOf('=') + 1).trim()) names.add(item.split('=')[0]!)
    }
  } catch { /* malformed inspect output is treated as missing */ }
  return names
}
if (dockerReady) {
  containerEnv = containerEnvironmentNames('api')
}
const relayNames = ['MODEL_RELAY_BASE_URL', 'MODEL_RELAY_API_KEY', 'AI_MODEL', 'IMAGE_MODEL', 'IMAGE_EDIT_MODEL', 'OCR_MODEL', 'VIDEO_MODEL']
const relayReady = relayNames.every(name => Boolean(process.env[name]) || containerEnv.has(name))
add('model_relay', relayReady ? 'pass' : production ? 'fail' : 'warn', relayReady ? '业务模型中转配置存在（值已隐藏）' : '业务模型中转配置不完整', '通过 Secret Manager/环境合同注入七项 relay 配置；不要复制密钥到仓库。')
const identitySessionReady = Boolean(process.env.SESSION_ID_HASH_SECRET) || containerEnv.has('SESSION_ID_HASH_SECRET')
add('identity_session_hash', identitySessionReady ? 'pass' : production ? 'fail' : 'warn', identitySessionReady ? '平台身份会话指纹密钥已注入（值已隐藏）' : '平台身份会话指纹密钥未注入', '通过 Secret Manager 注入独立 SESSION_ID_HASH_SECRET；不得复用 OIDC 或 API token。')
const hostRelayReady = commandReady('npm', ['run', 'codex:relay:validate', '--silent'])
const codexConfigPath = resolve(process.env.CODEX_CONFIG_PATH?.trim() || `${homedir()}/.codex/config.toml`)
const codexUsesSubscription = existsSync(codexConfigPath) && !/^\s*(?:model_provider|model)\s*=/mu.test(readFileSync(codexConfigPath, 'utf8'))
const hostAuthMessage = codexUsesSubscription ? '宿主 Codex 使用 ChatGPT 会员登录（业务模型仍走中转）' : '宿主 Codex 中转合同有效（值已隐藏）'
add('host_model_relay', hostRelayReady ? 'pass' : production ? 'fail' : 'warn', hostRelayReady ? hostAuthMessage : '宿主 Codex 认证/中转合同未就绪；容器配置不代表宿主可调用', '使用 ChatGPT 会员登录宿主 Codex，或按 ~/.codex/config.toml 中 provider 的 env_key 注入宿主密钥；随后运行 npm run codex:relay:validate。')

const bridgeEndpoint = process.env.MERCHANT_MCP_BASE_URL?.trim() ?? ''
const bridgeTokenPresent = Boolean(process.env.MERCHANT_MCP_TOKEN?.trim())
let bridgeEndpointValid = false
let bridgeLoopback = false
try {
  const parsed = new URL(bridgeEndpoint)
  bridgeLoopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)
  bridgeEndpointValid = (bridgeLoopback || parsed.protocol === 'https:') && !parsed.username && !parsed.password
    && !parsed.search && !parsed.hash && (parsed.pathname === '' || parsed.pathname === '/')
} catch { /* missing or malformed is blocked below */ }
const bridgeReady = bridgeEndpointValid && (bridgeLoopback || bridgeTokenPresent)
add('plugin_bridge', bridgeReady ? 'pass' : production ? 'fail' : 'warn', bridgeReady
  ? `Bridge endpoint 已配置（${bridgeLoopback ? 'loopback' : 'HTTPS'}；token=${bridgeTokenPresent ? 'present' : 'not-required'}）`
  : 'Bridge endpoint/token 合同未就绪', '设置根 origin MERCHANT_MCP_BASE_URL；远程环境同时从 Secret Manager 注入 MERCHANT_MCP_TOKEN，禁止在输出中显示 token。')

const workerServices = ['worker-sync', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-automation', 'worker-scan']
const workerCallbackReady = dockerReady && workerServices.every(service => {
  const names = containerEnvironmentNames(service)
  return names.has('WORKER_API_BASE_URL') && names.has('WORKER_API_TOKEN') && names.has('WORKER_API_SIGNING_SECRET')
})
add('worker_callback_auth', workerCallbackReady ? 'pass' : production ? 'fail' : 'warn', workerCallbackReady
  ? '所有 Worker callback endpoint/token/signing 配置存在（值已隐藏）'
  : 'Worker callback 身份合同不完整', '为每个 Worker 注入独立 WORKER_API_BASE_URL、WORKER_API_TOKEN 和 WORKER_API_SIGNING_SECRET。')

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
  const response = await fetch('http://127.0.0.1:8787/readyz', { signal: AbortSignal.timeout(1500) })
  const readiness = commercialRuntimeReadiness(await response.json() as unknown)
  const level = (ready: boolean | undefined): Level => ready ? 'pass' : production ? 'fail' : 'warn'
  add('commercial:persistence', level(readiness?.persistenceReady), `商业持久化 ready=${String(readiness?.persistenceReady)}`, '启动真 PostgreSQL，禁止用 memory/fixture 作为商业事实。')
  add('commercial:payment', level(readiness?.paymentReady), `支付 mode=${readiness?.paymentMode ?? 'unknown'}, ready=${String(readiness?.paymentReady)}`, '配置真实 provider、验签、防重、查询与对账；fixture 不得标记生产 ready。')
  add('commercial:model_relay', level(readiness?.modelRelayReady), `五模态中转与成本门禁 ready=${String(readiness?.modelRelayReady)}`, '逐模态配置真实中转鉴权、usage、cost 与错误证据。')
  add('commercial:object_storage', level(readiness?.objectStorageReady), `对象存储 mode=${readiness?.objectStorageMode ?? 'unknown'}, ready=${String(readiness?.objectStorageReady)}`, '配置真实对象存储/KMS/scanner 证据；local 模式不满足生产门禁。')
  add('commercial:scanner', level(readiness?.scannerReady), `scanner ready=${String(readiness?.scannerReady)}`, '配置非 fixture scanner、签名回执和新鲜度证据；仅容器存活不满足生产门禁。')
  add('commercial:alerts', level(readiness?.alertReady), `生产告警 ready=${String(readiness?.alertReady)}`, '注入告警 webhook/secret 并验证真实投递。')
  add('commercial:production_gate', level(readiness?.productionGate), `mode=${readiness?.mode ?? 'unknown'}, writes=${String(readiness?.writesEnabled)}, productionGate=${String(readiness?.productionGate)}`, '未满足真实支付、平台、存储、容量和证据前保持 writes disabled / NO-GO。')
} catch {
  add('commercial:runtime', production ? 'fail' : 'warn', '无法读取商业运行时 readiness', '启动 API，并确认 /readyz 返回非敏感的支付、五模态、存储和生产门禁状态。')
}

if (composeReady) {
  const sourceTail = Math.max(...readdirSync(resolve(root, 'packages/persistence/src/migrations'))
    .map(name => /^(\d{3})_.+\.sql$/u.exec(name)?.[1]).filter((value): value is string => Boolean(value)).map(Number))
  const sql = `SELECT json_build_object(
    'migration_tail',(SELECT max(version) FROM schema_migrations),
    'catalog_versions',(SELECT count(*) FROM commercial_catalog_sku_versions),
    'executable_catalog',(SELECT count(*) FROM commercial_catalog_sku_versions WHERE executable),
    'approved_rates',(SELECT count(*) FROM creative_point_rate_card_versions_v2 WHERE lifecycle='approved' AND approval_status='approved' AND executable),
    'point_projections',(SELECT count(*) FROM creative_point_access_state),
    'forced_rls',(SELECT count(*) FROM pg_class WHERE relname LIKE 'creative_point_%' AND relrowsecurity AND relforcerowsecurity),
    'app_bypass_rls',(SELECT rolbypassrls FROM pg_roles WHERE rolname='merchant_app')
  )`
  const probe = run('docker', ['compose', '-f', 'infra/local/docker-compose.yml', 'exec', '-T', 'postgres', 'psql', '-U', 'merchant', '-d', 'merchant', '-Atqc', sql])
  try {
    const facts = JSON.parse(probe.stdout.trim()) as Record<string, number | boolean | null>
    add('commercial:migration_tail', facts.migration_tail === sourceTail ? 'pass' : 'fail', `数据库迁移尾=${String(facts.migration_tail)}, source=${sourceTail}`, '运行不可变前向迁移；禁止删除容器卷或改写 schema_migrations。')
    add('commercial:database_security', facts.forced_rls === 6 && facts.app_bypass_rls === false ? 'pass' : 'fail', `创意点 FORCE RLS=${String(facts.forced_rls)}/6, merchant_app bypass=${String(facts.app_bypass_rls)}`, '修复 RLS/FORCE 与应用角色；跨租户或 BYPASSRLS 一律阻断发布。')
    add('commercial:catalog', Number(facts.catalog_versions) > 0 ? 'pass' : 'fail', `目录版本=${String(facts.catalog_versions)}, executable=${String(facts.executable_catalog)}`)
    const catalogReady = Number(facts.executable_catalog) > 0
    add('commercial:executable_catalog', catalogReady ? 'pass' : production ? 'fail' : 'warn', `已批准可执行目录版本=${String(facts.executable_catalog)}`, '业务/财务批准前目录保持不可执行；禁止用草稿开放收款或业务能力。')
    const rateReady = Number(facts.approved_rates) > 0
    add('commercial:approved_rate', rateReady ? 'pass' : production ? 'fail' : 'warn', `已批准可执行费率=${String(facts.approved_rates)}`, '财务/业务批准前保持 RATE_CARD_UNAVAILABLE，禁止工程自行批准。')
    add('commercial:point_projection', Number(facts.point_projections) > 0 ? 'pass' : production ? 'fail' : 'warn', `点数投影 workspace=${String(facts.point_projections)}`, '验证真实 grant→balance→access revision；空库不能证明生产恢复。')
  } catch {
    add('commercial:database_probe', production ? 'fail' : 'warn', '商业数据库诊断不可用或返回无效数据', '确认 postgres 容器、迁移尾、目录/费率/点数表和非 BYPASSRLS 角色。')
  }
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
