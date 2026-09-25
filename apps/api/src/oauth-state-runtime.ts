import { createRedisOAuthPort } from './redis-ports.js'
import { OAuthStateStore } from '../../../packages/security/src/oauth.js'
import { RedisOAuthStateStore } from '../../../packages/security/src/redis-oauth.js'

export const oauthStates = new OAuthStateStore()
const redisOAuthPort = createRedisOAuthPort(process.env.REDIS_URL)
type OAuthStateRuntimeStore = Pick<OAuthStateStore, 'issue' | 'consume' | 'consumeCallback'> | Pick<RedisOAuthStateStore, 'issue' | 'consume' | 'consumeCallback'>
const defaultOauthStateStore: OAuthStateRuntimeStore = redisOAuthPort ? new RedisOAuthStateStore(redisOAuthPort) : oauthStates
let overrideForTests: { store: OAuthStateRuntimeStore; satisfiesProductionRedisRequirement: boolean } | undefined

export function setOAuthStateStoreForTests(override?: { store: OAuthStateRuntimeStore; satisfiesProductionRedisRequirement?: boolean }) {
  if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') throw new Error('OAUTH_STATE_STORE_OVERRIDE_TEST_ONLY')
  overrideForTests = override ? { store: override.store, satisfiesProductionRedisRequirement: override.satisfiesProductionRedisRequirement === true } : undefined
}

export function oauthStateStore() { return overrideForTests?.store ?? defaultOauthStateStore }
export function oauthStateStoreProductionReady() { return overrideForTests?.satisfiesProductionRedisRequirement ?? Boolean(redisOAuthPort) }
