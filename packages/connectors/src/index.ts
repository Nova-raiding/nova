import { FakePlatformConnector } from './fake-connector.js'
import { createHttpConnector } from './http-connector.js'
import { jdProfile } from './profiles/jd.js'
import { taobaoProfile } from './profiles/taobao.js'
import { tmallProfile } from './profiles/tmall.js'
import { pinduoduoProfile } from './profiles/pinduoduo.js'
import { xiaohongshuProfile } from './profiles/xiaohongshu.js'
import { douyinProfile } from './profiles/douyin.js'
import type { FakeConnectorOptions, Platform, PlatformConnector } from './types.js'

export * from './types.js'
export * from './fake-connector.js'
export * from './http-connector.js'
export * from './config.js'
export * from './vault-provider.js'
export * from './platform-adapters/alibaba-top.js'
export * from './platform-adapters/jd.js'
export * from './platform-adapters/pinduoduo.js'
export * from './capability-evidence.js'
export * from './readiness.js'
export * from './platform-preflight.js'
export * from './canary.js'
export { jdProfile, taobaoProfile, tmallProfile, pinduoduoProfile, xiaohongshuProfile, douyinProfile }

export const profiles = { jd: jdProfile, taobao: taobaoProfile, tmall: tmallProfile, pinduoduo: pinduoduoProfile, xiaohongshu: xiaohongshuProfile, douyin: douyinProfile } as const

export function createFakeConnector(platform: Platform, options?: FakeConnectorOptions): PlatformConnector {
  return new FakePlatformConnector(profiles[platform], options)
}

export function createConfiguredConnector(platform: Platform, options: import('./http-connector.js').HttpPlatformConnectorOptions): PlatformConnector {
  return createHttpConnector(platform, options)
}
