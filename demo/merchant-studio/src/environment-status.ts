import type { ApiHealth, PlatformModelStatus } from './api'

export type MerchantEnvironmentState =
  | 'offline'
  | 'unavailable'
  | 'checking'
  | 'demo'
  | 'manual'
  | 'blocked'
  | 'ready'

export interface MerchantEnvironmentPresentation {
  state: MerchantEnvironmentState
  tone: 'ready' | 'warning'
  topbarLabel: string
  title: string
  detail: string
  facts: string[]
  actions: string[]
}

interface MerchantEnvironmentInput {
  apiBaseUrl?: string
  apiOnline: boolean | null
  apiHealth: ApiHealth | null
  modelStatus: PlatformModelStatus | null
  modelStatusRead: boolean
}

const modeLabels: Record<string, string> = {
  fixture: '本地演示',
  demo: '演示',
  test: '测试',
  local: '本地开发',
  production: '生产',
  manual: '人工运营',
}

const demoModes = new Set(['fixture', 'demo', 'test', 'local'])
const manualModes = new Set(['manual'])

function modelFact(
  modelStatus: PlatformModelStatus | null,
  modelStatusRead: boolean,
) {
  if (!modelStatusRead) return '模型中转：读取中'
  if (!modelStatus) return '模型中转：读取失败，服务端不会放行生成'
  return `模型中转：${modelStatus.state === 'ready' ? '当前环境可用' : '未就绪，服务端会阻止生成'}`
}

export function resolveMerchantEnvironmentStatus({
  apiBaseUrl,
  apiOnline,
  apiHealth,
  modelStatus,
  modelStatusRead,
}: MerchantEnvironmentInput): MerchantEnvironmentPresentation {
  if (!apiBaseUrl) {
    return {
      state: 'offline',
      tone: 'warning',
      topbarLabel: '离线演示',
      title: '离线演示 · 不可上线',
      detail: '未配置工作区 API，不会读取或写入真实店铺数据。',
      facts: ['API 连通：未配置', '生产门禁：未确认', modelFact(modelStatus, modelStatusRead)],
      actions: ['配置工作区 API 后重新检查上线状态。'],
    }
  }

  if (apiOnline === false) {
    return {
      state: 'unavailable',
      tone: 'warning',
      topbarLabel: 'API 不可用',
      title: 'API 暂不可用',
      detail: '无法读取服务端健康状态；同步、生成和发布不会在离线状态下伪造成功。',
      facts: ['API 连通：失败', '生产门禁：无法确认', modelFact(modelStatus, modelStatusRead)],
      actions: ['检查 API 地址、鉴权和服务状态后重新检查。'],
    }
  }

  if (apiOnline !== true || !apiHealth) {
    return {
      state: 'checking',
      tone: 'warning',
      topbarLabel: '状态待确认',
      title: '正在确认环境状态',
      detail: '尚未取得完整的服务端健康证据，当前不会标记为生产就绪。',
      facts: ['API 连通：检查中', '生产门禁：待确认', modelFact(modelStatus, modelStatusRead)],
      actions: ['等待健康检查完成；若长时间无结果，请检查 API 鉴权。'],
    }
  }

  const mode = apiHealth.setup?.mode?.trim().toLowerCase() || 'unknown'
  const modeLabel = modeLabels[mode] ?? mode
  const isDemo = demoModes.has(mode)
  const isManual = manualModes.has(mode)
  const productionGate = apiHealth.setup?.productionGate
  const writesEnabled = apiHealth.writesEnabled
  const modelReady = modelStatusRead && modelStatus?.state === 'ready'
  const productionReady = mode === 'production'
    && productionGate === true
    && writesEnabled === true
    && modelReady
  const blockers: string[] = []

  if (isDemo || isManual) blockers.push(`当前是${modeLabel}模式`)
  else if (mode !== 'production') blockers.push('未确认当前为生产环境')
  if (writesEnabled === false) blockers.push('外部平台写入已关闭')
  else if (writesEnabled !== true) blockers.push('未返回外部写入能力证据')
  if (productionGate === false) blockers.push('生产上线门禁未通过')
  else if (productionGate !== true) blockers.push('未返回生产上线门禁证据')
  if (!modelStatusRead) blockers.push('模型中转状态仍在读取')
  else if (!modelReady) blockers.push('模型中转未就绪')

  const facts = [
    'API 连通：正常',
    `运行模式：${modeLabel}`,
    `外部写入：${writesEnabled === true ? '已开放' : writesEnabled === false ? '已关闭' : '未确认'}`,
    `生产门禁：${productionGate === true ? '已通过' : productionGate === false ? '未通过' : '未确认'}`,
    modelFact(modelStatus, modelStatusRead),
  ]
  const actions: string[] = []
  if (isDemo)
    actions.push('如需上线，请管理员切换到生产模式，并完成平台官方授权与生产门禁。')
  if (isManual)
    actions.push('当前为人工运营模式：平台授权、商品同步和正式发布由运营人员在官方后台完成；本页面不会自动写入平台。')
  if (writesEnabled !== true && !isManual)
    actions.push('请管理员完成可写平台连接；当前页面不会提交真实平台写入。')
  if (!isDemo && productionGate !== true)
    actions.push('请管理员在运营后台查看并处理未通过或缺失的生产门禁。')

  if (productionReady) {
    return {
      state: 'ready',
      tone: 'ready',
      topbarLabel: '生产就绪',
      title: '生产环境已就绪',
      detail: '生产上线门禁、外部平台写入和模型中转均已通过服务端检查。',
      facts,
      actions,
    }
  }

  const modelDetail = modelReady
    ? '模型中转仅在当前环境可用，不代表生产就绪。'
    : '生成、图片、OCR 和视频能力将继续受服务端门禁限制。'

  return {
    state: isDemo ? 'demo' : isManual ? 'manual' : 'blocked',
    tone: 'warning',
    topbarLabel: isDemo ? '演示环境' : isManual ? '人工运营模式' : '不可上线',
    title: isDemo ? '演示环境 · 不可上线' : isManual ? '人工运营模式 · 不自动写入平台' : '当前环境不可上线',
    detail: `${blockers.join('；')}。${modelDetail}`,
    facts,
    actions,
  }
}
