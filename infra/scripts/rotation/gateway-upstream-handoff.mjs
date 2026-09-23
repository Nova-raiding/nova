import { createHash } from 'node:crypto'

const hostPattern = /^[a-z0-9][a-z0-9.-]{0,252}$/

export const sha256 = value => createHash('sha256').update(value).digest('hex')

// Rewrite only the single API server in the actual running nginx configuration.
// The caller must compare the source digest with a protected runtime snapshot,
// install the result atomically, run nginx -t, then reload and verify traffic.
export function rewriteApiUpstream(config, from, to) {
  if (typeof config !== 'string' || !hostPattern.test(from) || !hostPattern.test(to) || from === to) {
    throw new Error('INVALID_GATEWAY_HANDOFF_INPUT')
  }
  const blocks = [...config.matchAll(/(^|\n)([ \t]*upstream[ \t]+pilot_api[ \t]*\{)([\s\S]*?)(^[ \t]*\})/gm)]
  if (blocks.length !== 1) throw new Error('API_UPSTREAM_BLOCK_NOT_UNIQUE')
  const block = blocks[0]
  const servers = [...block[3].matchAll(/^[ \t]*server[ \t]+([^;]+);[ \t]*$/gm)]
  if (servers.length !== 1 || servers[0][1].trim() !== `${from}:8787 resolve`) {
    throw new Error('API_UPSTREAM_SERVER_DRIFT')
  }
  const server = servers[0][0]
  const rewrittenBlock = block[0].replace(server, server.replace(`${from}:8787`, `${to}:8787`))
  if (rewrittenBlock === block[0]) throw new Error('API_UPSTREAM_REWRITE_FAILED')
  const rewritten = config.slice(0, block.index) + rewrittenBlock + config.slice(block.index + block[0].length)
  if (rewritten.replace(`${to}:8787 resolve`, `${from}:8787 resolve`) !== config) {
    throw new Error('API_UPSTREAM_SCOPE_DRIFT')
  }
  return { config: rewritten, before_sha256: sha256(config), after_sha256: sha256(rewritten) }
}
