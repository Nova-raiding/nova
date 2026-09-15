import type { ApiHealth, PlatformModelStatus } from './api.js'

export type MerchantEnvironmentState =
  | 'offline'
  | 'unavailable'
  | 'checking'
  | 'demo'
  | 'blocked'
  | 'ready'

export interface MerchantEnvironmentPresentation {
  state: MerchantEnvironmentState
  tone: 'ready' | 'warning'
  topbarPrefix: '系统健康' | '系统状态'
  topbarLabel: string
  title: string
  detail: string
  facts: string[]
  nextActions: string[]
}

const demoModes = new Set(['fixture', 'demo', 'test', 'local'])

function modelSummary(
  modelStatus: PlatformModelStatus | null,
  modelStatusRead: boolean,
  productionReady: boolean,
): string {
  if (modelStatus?.state === 'ready')
    return productionReady
      ? '模型中转已就绪。'
      : '模型中转仅在当前环境可用，不代表生产就绪。'
  if (modelStatus)
    return '模型中转未就绪，生成、图片、OCR 和视频能力会由服务端阻止。'
  return modelStatusRead
    ? '模型中转状态读取失败，生成能力不会被放行。'
    : '正在读取模型中转状态。'
}

export function resolveMerchantEnvironmentStatus({
  apiConfigured,
  apiOnline,
  health,
  modelStatus,
  modelStatusRead,
}: {
  apiConfigured: boolean
  apiOnline: boolean | null
  health: ApiHealth | null
  modelStatus: PlatformModelStatus | null
  modelStatusRead: boolean
}): MerchantEnvironmentPresentation {
  if (!apiConfigured)
    return {
      state: 'offline',
      tone: 'warning',
      topbarPrefix: '系统状态',
      topbarLabel: '离线演示',
      title: '当前为离线演示模式',
      detail: '未配置 API 地址，不会读取或写入真实店铺数据；配置后再开始真实操作。',
      facts: ['API：未配置', '真实店铺读写：未启用'],
      nextActions: [],
    }

  if (apiOnline === false)
    return {
      state: 'unavailable',
      tone: 'warning',
      topbarPrefix: '系统状态',
      topbarLabel: 'API 不可用',
      title: 'API 暂不可用',
      detail: '当前不会伪造同步、生成或发布成功；请检查 API 地址和服务状态。',
      facts: ['API 连通：失败', '真实操作：已阻止'],
      nextActions: [],
    }

  if (apiOnline !== true || !health)
    return {
      state: 'checking',
      tone: 'warning',
      topbarPrefix: '系统状态',
      topbarLabel: '检查中',
      title: '正在核验环境状态',
      detail: '尚未取得服务端生产门禁结果；在状态明确前不会标记在线或生产就绪。',
      facts: ['生产门禁：待确认', '写入能力：待确认'],
      nextActions: [],
    }

  const mode = health.setup?.mode?.trim() || '未声明'
  const demoMode = demoModes.has(mode.toLowerCase())
  const writesBlocked = health.writesEnabled === false
  const gateBlocked = health.setup?.productionGate === false
  const gateUnknown = health.setup?.productionGate !== true
  const writesUnknown = health.writesEnabled !== true
  const explicitBlock = demoMode || writesBlocked || gateBlocked
  const facts = [
    `环境模式：${mode}`,
    `写入能力：${writesBlocked ? '已关闭' : writesUnknown ? '待确认' : '已开启'}`,
    `生产门禁：${gateBlocked ? '未通过' : gateUnknown ? '待确认' : '已通过'}`,
  ]
  const nextActions = (health.setup?.nextActions ?? [])
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())

  if (explicitBlock) {
    const title = demoMode ? '演示环境 · 不可上线' : '当前环境不可上线'
    return {
      state: demoMode ? 'demo' : 'blocked',
      tone: 'warning',
      topbarPrefix: '系统状态',
      topbarLabel: demoMode ? '演示环境' : '不可上线',
      title,
      detail: `${facts.join('；')}。${modelSummary(modelStatus, modelStatusRead, false)}`,
      facts,
      nextActions,
    }
  }

  if (gateUnknown || writesUnknown) {
    return {
      state: 'checking',
      tone: 'warning',
      topbarPrefix: '系统状态',
      topbarLabel: '待确认',
      title: '生产状态待确认',
      detail: `${facts.join('；')}。在服务端明确通过门禁前，不会显示生产在线。`,
      facts,
      nextActions,
    }
  }

  const modelReady = modelStatusRead && modelStatus?.state === 'ready'
  if (!modelReady) {
    return {
      state: 'blocked',
      tone: 'warning',
      topbarPrefix: '系统状态',
      topbarLabel: '能力受限',
      title: '模型中转未就绪',
      detail: `${facts.join('；')}。${modelSummary(modelStatus, modelStatusRead, true)}`,
      facts,
      nextActions: [...(modelStatus?.next_actions ?? []), ...nextActions],
    }
  }

  return {
    state: 'ready',
    tone: 'ready',
    topbarPrefix: '系统健康',
    topbarLabel: '在线',
    title: '生产环境已就绪',
    detail: `商品、店铺、任务和发布状态以当前工作区的服务端数据为准。${modelSummary(modelStatus, modelStatusRead, true)}`,
    facts,
    nextActions,
  }
}
