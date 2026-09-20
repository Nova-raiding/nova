import { afterEach, describe, expect, it, vi } from 'vitest'
import { composeMarketingImages, trustedDashScopeImageArtifactHost } from './image-marketing-compositor.js'

const brief = { productTitle: '浅蓝防雨冲锋衣', marketingLabels: ['防雨通勤'] }

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('marketing compositor outbound image boundary', () => {
  it('refuses a provider artifact host outside the allowlist in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('IMAGE_ARTIFACT_ALLOWED_HOSTS', 'images.merchant-assets.cn')
    const fetchImpl = vi.fn()
    await expect(composeMarketingImages(['https://internal.example.net/secret.png'], brief, fetchImpl as unknown as typeof fetch)).rejects.toThrow('HOST_NOT_ALLOWLISTED')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fails closed in production when the artifact allowlist is not configured', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('IMAGE_ARTIFACT_ALLOWED_HOSTS', '')
    const fetchImpl = vi.fn()
    await expect(composeMarketingImages(['https://relay.example/result.png'], brief, fetchImpl as unknown as typeof fetch)).rejects.toThrow('IMAGE_ARTIFACT_ALLOWED_HOSTS')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('blocks private and internal hosts outside production too', async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('IMAGE_ARTIFACT_ALLOWED_HOSTS', '')
    const fetchImpl = vi.fn()
    await expect(composeMarketingImages(['https://127.0.0.1/secret.png'], brief, fetchImpl as unknown as typeof fetch)).rejects.toThrow('unsafe outbound URL')
    await expect(composeMarketingImages(['https://printer.internal/secret.png'], brief, fetchImpl as unknown as typeof fetch)).rejects.toThrow('unsafe outbound URL')
    await expect(composeMarketingImages(['http://relay.example/result.png'], brief, fetchImpl as unknown as typeof fetch)).rejects.toThrow('data-url or HTTPS image')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('bounds the download in time and follows the caller cancellation', async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('IMAGE_ARTIFACT_ALLOWED_HOSTS', 'images.merchant-assets.cn')
    const seen: Array<RequestInit | undefined> = []
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push(init)
      return new Response('', { status: 502 })
    }) as unknown as typeof fetch
    const controller = new AbortController()
    await expect(composeMarketingImages(['https://images.merchant-assets.cn/a.png'], brief, fetchImpl, { signal: controller.signal })).rejects.toThrow('HTTP 502')
    expect(seen[0]?.redirect).toBe('error')
    const signal = seen[0]?.signal
    expect(signal).toBeInstanceOf(AbortSignal)
    controller.abort()
    expect((signal as AbortSignal).aborted).toBe(true)
  })

  it('keeps data urls off the network', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('IMAGE_ARTIFACT_ALLOWED_HOSTS', '')
    const fetchImpl = vi.fn()
    await expect(composeMarketingImages(['data:image/png;base64,not-a-real-png'], brief, fetchImpl as unknown as typeof fetch)).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('accepts only the documented DashScope OSS artifact host shape', () => {
    expect(trustedDashScopeImageArtifactHost('https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/result.png')).toBe('dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com')
    expect(trustedDashScopeImageArtifactHost('https://evil.aliyuncs.com/result.png')).toBeUndefined()
    expect(trustedDashScopeImageArtifactHost('https://dashscope-a.oss-cn-x.aliyuncs.com.evil.example/result.png')).toBeUndefined()
  })
})
