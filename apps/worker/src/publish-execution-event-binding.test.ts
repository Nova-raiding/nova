import { describe, expect, it } from 'vitest'
import type { DurableOutboxEvent } from '../../../packages/workers/src/durable.js'
import { assertPublishExecution } from './main.js'

describe('publish execution authorization binding', () => {
  it('sends the durable event id to the publish execution gate', async () => {
    const event: DurableOutboxEvent = {
      id: 'evt_publish_binding', workspaceId: 'ws_publish_binding', aggregateId: 'job_publish_binding',
      eventType: 'publish.requested', sequence: 1, payload: {}, createdAt: new Date().toISOString(),
    }
    let requestedUrl = ''
    await assertPublishExecution({
      apiBaseUrl: 'https://api.example', apiToken: 'worker-token', event,
      fetcher: async (input) => {
        requestedUrl = String(input)
        return new Response(JSON.stringify({ data: { credential_ref: 'vault://merchant/ws_publish_binding/jd', payload_hash: 'a'.repeat(64) } }), { status: 200 })
      },
    })
    expect(new URL(requestedUrl).searchParams.get('event_id')).toBe(event.id)
  })
})
