// Isolated control core. No host CLI or direct production mutation entry point.
import { createHash } from 'node:crypto'

const SHA = /^[a-f0-9]{64}$/u
const ID = /^[a-f0-9]{64}$/u
const sha = text => createHash('sha256').update(text).digest('hex')
const requireThat = (ok, code) => { if (!ok) throw new Error(`GATEWAY_FENCE_${code}`) }
const HEALTHCHECK = "wget --no-check-certificate --header='Host: yxsona.com' -qO- https://127.0.0.1:8443/healthz >/dev/null || exit 1"

export function renderGatewayFence(config, exactCallbacks) {
  requireThat(typeof config === 'string' && !config.includes('merchant_maintenance_block'), 'CONFIG_DRIFT')
  // $remote_addr must remain the socket peer. A real_ip module mapping could
  // make a caller-controlled forwarding header look like loopback.
  requireThat(!/^\s*(?:set_real_ip_from|real_ip_header|real_ip_recursive)\b/mu.test(config), 'REAL_IP_TRUST_UNVERIFIED')
  requireThat(Array.isArray(exactCallbacks) && exactCallbacks.length > 0, 'CALLBACK_POLICY_MISSING')
  const routes = [...new Set(exactCallbacks)]
  requireThat(routes.length === exactCallbacks.length && routes.every(x =>
    typeof x === 'string' && /^\/[a-z0-9\/-]+$/u.test(x) && !x.includes('//')), 'CALLBACK_PATH_INVALID')
  const anchor = /server \{\s*listen 8443 ssl;\s*server_name yxsona\.com www\.yxsona\.com admin\.yxsona\.com ops\.yxsona\.com;/gu
  const matches = [...config.matchAll(anchor)]
  requireThat(matches.length === 1, 'PUBLIC_SERVER_NOT_UNIQUE')
  const firstServer = config.indexOf('server {')
  requireThat(firstServer >= 0 && firstServer < matches[0].index, 'CONFIG_SCOPE_INVALID')
  const map = `# merchant maintenance fence; exact POST callbacks and container-local health only\nmap "$request_method:$uri" $merchant_callback_block {\n  default 1;\n${routes.map(x => `  "POST:${x}" 0;`).join('\n')}\n}\nmap "$request_method:$uri:$remote_addr:$host" $merchant_local_health_block {\n  default 1;\n  "GET:/healthz:127.0.0.1:yxsona.com" 0;\n}\nmap "$merchant_callback_block:$merchant_local_health_block" $merchant_maintenance_block {\n  default 1;\n  "0:1" 0;\n  "1:0" 0;\n}\n\n`
  const withMap = config.slice(0, firstServer) + map + config.slice(firstServer)
  const publicAnchor = matches[0][0]
  const guard = `${publicAnchor}\n  if ($merchant_maintenance_block) { return 503; }`
  requireThat(withMap.includes(publicAnchor), 'PUBLIC_SERVER_DRIFT')
  const fenced = withMap.replace(publicAnchor, guard)
  requireThat(fenced !== config && fenced.split('if ($merchant_maintenance_block)').length === 2, 'FENCE_RENDER_FAILED')
  return { config: fenced, before_sha256: sha(config), fenced_sha256: sha(fenced), callback_paths: routes }
}

function validateIdentity(capsule, live, verify) {
  requireThat(typeof verify === 'function' && verify(capsule) === true, 'CAPSULE_SIGNATURE_INVALID')
  requireThat(ID.test(capsule?.gateway_id ?? '') && capsule.gateway_id === live?.Id
    && /^sha256:[a-f0-9]{64}$/u.test(capsule.image_id ?? '') && capsule.image_id === live?.Image
    && live?.State?.Running === true
    && live?.Config?.Healthcheck?.Test?.[0] === 'CMD-SHELL'
    && live.Config.Healthcheck.Test[1] === HEALTHCHECK
    && capsule.project === live?.Config?.Labels?.['com.docker.compose.project']
    && capsule.service === live?.Config?.Labels?.['com.docker.compose.service']
    && capsule.project === 'merchant-demo-85575f9c' && capsule.service === 'pilot-gateway'
    && capsule.host_ports?.join(',') === '80,443'
    && live?.HostConfig?.PortBindings?.['8080/tcp']?.some(x => x.HostPort === '80')
    && live?.HostConfig?.PortBindings?.['8443/tcp']?.some(x => x.HostPort === '443')
    && ID.test(capsule.network_id ?? '')
    && live?.NetworkSettings?.Networks?.[`${capsule.project}_default`]?.NetworkID === capsule.network_id
    && SHA.test(capsule.config_sha256 ?? '')
    && SHA.test(capsule.effective_config_sha256 ?? '')
    && capsule.rollback?.gateway_id === capsule.gateway_id
    && capsule.rollback?.config_sha256 === capsule.config_sha256
    && capsule.rollback?.db_prefix === 242
    && SHA.test(capsule.rollback?.archive_sha256 ?? ''), 'CAPSULE_IDENTITY_MISMATCH')
}

/** Ports are supplied only by a separately reviewed root-owned installer. */
export async function applyGatewayFencePrototype({ capsule, callbacks, verify, port }) {
  await port.assertLock()
  validateIdentity(capsule, await port.inspect(), verify)
  requireThat(await port.assertNoRealIpModules(capsule.effective_config_sha256) === true,
    'REAL_IP_TRUST_UNVERIFIED')
  requireThat(verify(callbacks) === true && callbacks.gateway_id === capsule.gateway_id
    && callbacks.exact_paths?.length > 0, 'CALLBACK_POLICY_UNVERIFIED')
  const before = await port.readConfig()
  requireThat(sha(before) === capsule.config_sha256, 'BASELINE_CONFIG_DRIFT')
  const rendered = renderGatewayFence(before, callbacks.exact_paths)
  requireThat(await port.saveOriginal(before, rendered.before_sha256) === true, 'ROLLBACK_NOT_DURABLE')
  let attempted = false
  try {
    attempted = true
    await port.writeConfig(rendered.config)
    requireThat(sha(await port.readConfig()) === rendered.fenced_sha256, 'FENCE_WRITE_DRIFT')
    requireThat(await port.nginxTest() === true, 'NGINX_TEST_FAILED')
    await port.reload()
    const probe = await port.probe(rendered.callback_paths)
    requireThat(probe?.gateway_id === capsule.gateway_id && probe?.ports?.join(',') === '80,443'
      && probe?.new_business_status === 503 && probe?.callback_paths?.join(',') === rendered.callback_paths.join(',')
      && probe?.callbacks_reached_api === true && probe?.container_local_health_status === 200
      && probe?.public_health_status === 503, 'FENCE_PROBE_FAILED')
    return { status: 'fenced_review_only', deployment_allowed: false,
      before_sha256: rendered.before_sha256, fenced_sha256: rendered.fenced_sha256 }
  } catch (error) {
    if (attempted) {
      try {
        await port.writeConfig(before)
        requireThat(sha(await port.readConfig()) === rendered.before_sha256, 'ROLLBACK_WRITE_DRIFT')
        requireThat(await port.nginxTest() === true, 'ROLLBACK_NGINX_TEST_FAILED')
        await port.reload()
        requireThat((await port.probeBaseline()) === true, 'ROLLBACK_PROBE_FAILED')
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'gateway fence failed and rollback is unverified')
      }
    }
    throw error
  }
}

export function reviewGatewayDrainPair({ first, second, fenced_sha256, gateway_id, verify }) {
  requireThat(typeof verify === 'function' && verify(first) === true && verify(second) === true, 'DRAIN_SIGNATURE_INVALID')
  requireThat(SHA.test(fenced_sha256 ?? '') && ID.test(gateway_id ?? '')
    && [first, second].every(x => x?.gateway_id === gateway_id && x?.fenced_sha256 === fenced_sha256
      && x?.ingress_fenced === true && x?.callbacks_reached_api === true), 'DRAIN_BINDING_MISMATCH')
  requireThat(Number.isSafeInteger(first.at_ms) && Number.isSafeInteger(second.at_ms)
    && second.at_ms - first.at_ms >= 30_000, 'DRAIN_WINDOW_TOO_SHORT')
  const counters = ['in_flight_requests', 'active_worker_cycles', 'active_outbox_leases',
    'provider_started_unresolved', 'unknown_outcomes', 'unpublished_outbox_events']
  requireThat([first, second].every(x => counters.every(key => x[key] === 0)), 'WORK_NOT_DRAINED')
  return { status: 'drained_review_only', deployment_allowed: false }
}
