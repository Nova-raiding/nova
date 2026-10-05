/** Real signed reconciliation client in a fresh process; no provider configuration. */
import { postImageGenerationReconciliation } from '../../apps/worker/src/main.js'
const base = new URL(process.env.WORKER_API_BASE_URL!)
if (base.hostname !== '127.0.0.1' || !process.env.MERCHANT_ISOLATED_POSTGRES_RUN_ID) throw new Error('OWNED_LOOPBACK_REQUIRED')
const result = await postImageGenerationReconciliation({ apiBaseUrl: base.toString(), apiToken: process.env.WORKER_API_TOKEN!, signingSecret: process.env.WORKER_API_SIGNING_SECRET!, workspaceId: process.env.WORKER_WORKSPACES!, limit: 100 })
console.log(JSON.stringify(result))
