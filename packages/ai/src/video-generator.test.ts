import { describe, expect, it } from 'vitest'
import { createVideoGeneratorFromEnv, OpenAICompatibleVideoGenerator } from './video-generator.js'

describe('video generator relay', () => {
  it('uses the platform relay and accepts a completed HTTPS artifact', async () => {
    const calls: Array<{ url: string; body: string }> = []
    const generator = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example', apiKey: 'relay-secret', model: 'video-v1',
      fetch: (async (url, init) => {
        calls.push({ url: String(url), body: String(init?.body) })
        return new Response(JSON.stringify({ data: { id: 'vid_1', video_url: 'https://cdn.example/video.mp4' } }), { status: 200 })
      }) as typeof fetch,
    })
    await expect(generator.generate({ prompt: '生成春季上新短视频', output: 'rendering', context: { product: { id: 'p1' } } })).resolves.toEqual({ status: 'completed', videoUrl: 'https://cdn.example/video.mp4', providerJobId: 'vid_1' })
    expect(calls[0]?.url).toBe('https://relay.example/video/generations')
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ model: 'video-v1', prompt: '生成春季上新短视频' })
  })

  it('accepts an opaque queued provider job but rejects non-HTTPS artifacts', async () => {
    const queued = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example', apiKey: 'relay-secret', model: 'video-v1',
      fetch: (async () => new Response(JSON.stringify({ task_id: 'job_1', status: 'queued' }), { status: 200 })) as typeof fetch,
    })
    await expect(queued.generate({ prompt: '生成视频', output: 'rendering', context: {} })).resolves.toEqual({ status: 'queued', providerJobId: 'job_1' })

    const invalid = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example', apiKey: 'relay-secret', model: 'video-v1',
      fetch: (async () => new Response(JSON.stringify({ url: 'http://cdn.example/video.mp4' }), { status: 200 })) as typeof fetch,
    })
    await expect(invalid.generate({ prompt: '生成视频', output: 'rendering', context: {} })).rejects.toThrow('neither an HTTPS artifact URL nor a provider job id')
  })

  it('queries an opaque provider job without charging the wallet again', async () => {
    let method = ''
    let url = ''
    const generator = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example', apiKey: 'relay-secret', model: 'video-v1',
      fetch: (async (input, init) => { url = String(input); method = init?.method ?? ''; return new Response(JSON.stringify({ data: { task_id: 'job_1', status: 'completed', output_url: 'https://cdn.example/video.mp4' } }), { status: 200 }) }) as typeof fetch,
    })
    await expect(generator.getStatus('job_1')).resolves.toEqual({ status: 'completed', videoUrl: 'https://cdn.example/video.mp4', providerJobId: 'job_1' })
    expect(method).toBe('GET')
    expect(url).toBe('https://relay.example/video/generations/job_1')
  })

  it('does not trust a completed status without an HTTPS artifact', async () => {
    const generator = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example', apiKey: 'relay-secret', model: 'video-v1',
      fetch: (async () => new Response(JSON.stringify({ data: { id: 'job_1', status: 'completed' } }), { status: 200 })) as typeof fetch,
    })
    await expect(generator.getStatus('job_1')).rejects.toThrow('completed without an HTTPS artifact URL')
  })

  it('requires the HTTPS platform relay in every environment', () => {
    expect(createVideoGeneratorFromEnv({ VIDEO_BASE_URL: 'https://direct.example', VIDEO_API_KEY: 'direct', VIDEO_MODEL: 'v1' })).toBeUndefined()
    expect(createVideoGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'http://relay.example', MODEL_RELAY_API_KEY: 'relay', VIDEO_MODEL: 'v1' })).toBeUndefined()
    expect(createVideoGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example', MODEL_RELAY_API_KEY: 'relay', VIDEO_MODEL: 'v1' })).toBeDefined()
    expect(createVideoGeneratorFromEnv({ MODEL_RELAY_BASE_URL: 'https://relay.example', VIDEO_MODEL_RELAY_API_KEY: 'video-relay', VIDEO_MODEL: 'v1' })).toBeDefined()
  })
})
