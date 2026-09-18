import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const text = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

describe('alert receiver deployment contract', () => {
  it('builds a non-root dedicated image with a database-backed readiness probe', async () => {
    const dockerfile = await text('infra/docker/alert-receiver.Dockerfile')
    expect(dockerfile).toMatch(/^FROM --platform=\$BUILDPLATFORM node:22-alpine@sha256:[0-9a-f]{64} AS build$/mu)
    expect(dockerfile).toMatch(/^FROM node:22-alpine@sha256:[0-9a-f]{64} AS runtime$/mu)
    expect(dockerfile).toContain('USER 10001:10001')
    expect(dockerfile).toContain('EXPOSE 8791')
    expect(dockerfile).toContain('127.0.0.1:8791/readyz')
    expect(dockerfile).toContain('dist/apps/alert-receiver/src/server.js')
  })

  it('probes the primary TLS virtual host instead of the isolated alert host', async () => {
    const dockerfile = await text('infra/docker/pilot-gateway-https.Dockerfile')
    expect(dockerfile).toContain("--header='Host: yxsona.com'")
    expect(dockerfile).toContain('https://127.0.0.1:8443/healthz')
  })

  it('keeps ECS secrets file-mounted and the receiver off host ports', async () => {
    const compose = await text('infra/local/docker-compose.ecs-pilot.yml')
    const receiver = compose.slice(compose.indexOf('  alert-receiver:'), compose.indexOf('\n  payment-gateway:'))
    expect(receiver).toContain('ALERT_RECEIVER_DATABASE_URL_FILE:')
    expect(receiver).toContain('ALERT_RECEIVER_HMAC_SECRET_FILE:')
    expect(receiver).toContain('read_only: true')
    expect(receiver).toContain('<<: *ecs-node-hardening')
    const nodeHardening = compose.slice(compose.indexOf('x-ecs-node-hardening:'), compose.indexOf('\nx-ecs-nginx-hardening:'))
    expect(nodeHardening).toContain('&ecs-node-hardening')
    expect(nodeHardening).toContain('security_opt: [no-new-privileges:true]')
    expect(receiver).toContain('bind: {create_host_path: false}')
    expect(receiver).toContain('expose: ["8791"]')
    expect(receiver).toContain('profiles: ["alerts"]')
    expect(receiver).not.toMatch(/\n\s+ports:/u)
  })

  it('keeps both API senders disconnected from the separately profiled receiver by default', async () => {
    const compose = await text('infra/local/docker-compose.ecs-pilot.yml')
    const primary = compose.slice(compose.indexOf('  api:'), compose.indexOf('\n  api-replica:'))
    const replica = compose.slice(compose.indexOf('  api-replica:'), compose.indexOf('\n  worker-scan:'))
    expect(primary).toContain('OPS_ALERT_NOTIFICATIONS_ENABLED: "false"')
    expect(primary).toContain('ALERT_CHANNEL_SECRET_REF: ""')
    expect(primary).toContain('OPS_ALERT_WEBHOOK_URL: ""')
    expect(primary).toContain('OPS_ALERT_WEBHOOK_ALLOWED_HOSTS: ""')
    expect(primary).toContain('OPS_ALERT_WEBHOOK_SECRET_FILE: ""')
    expect(replica).toContain('environment: *ecs-production-api-environment')
    for (const service of [primary, replica]) {
      expect(service).not.toContain('/opt/merchant-deploy/deploy/secrets/alert_receiver_hmac_secret')
      expect(service).not.toMatch(/\n\s+OPS_ALERT_WEBHOOK_SECRET:/u)
    }
  })

  it('does not make the disabled alert receiver a pilot gateway dependency', async () => {
    const compose = await text('infra/local/docker-compose.ecs-pilot.yml')
    const gateway = compose.slice(compose.indexOf('  pilot-gateway:'))
    expect(gateway).not.toContain('alert-receiver: { condition: service_healthy }')
  })

  it('uses an exact HTTPS route and does not expose receiver health endpoints', async () => {
    const [ingress, nginx] = await Promise.all([
      text('infra/kubernetes/base/ingress.yaml'),
      text('infra/nginx/pilot-gateway-https.conf'),
    ])
    const alertRule = ingress.slice(ingress.indexOf('    - host: alerts.yxsona.com'), ingress.indexOf('    - host: yxsona.com'))
    expect(ingress).toContain('host: alerts.yxsona.com')
    expect(alertRule).toMatch(/path: \/internal\/v1\/alerts\n\s+pathType: Exact/u)
    expect(alertRule).not.toMatch(/path: \/(?:healthz|readyz)/u)
    expect(nginx).toContain('server_name alerts.yxsona.com;')
    expect(nginx).toContain('client_max_body_size 256k;')
    expect(nginx).toContain('limit_except POST')
    const alertServerStart = nginx.indexOf('server_name alerts.yxsona.com;')
    const alertServer = nginx.slice(alertServerStart, nginx.indexOf('server_name yxsona.com', alertServerStart))
    expect(alertServer).toContain('resolver 127.0.0.11')
    expect(alertServer).toContain('set $alert_receiver_upstream http://alert-receiver:8791;')
    expect(alertServer).toContain('location = /internal/v1/alerts')
    expect(alertServer).toContain('proxy_pass $alert_receiver_upstream;')
    expect(alertServer).toContain('location / { return 404; }')
    expect(alertServer).not.toMatch(/location\s*=\s*\/(?:healthz|readyz)/u)
  })

  it('injects Kubernetes secrets by read-only file and restricts network paths', async () => {
    const [deployment, policy, contract, kustomization] = await Promise.all([
      text('infra/kubernetes/base/alert-receiver.yaml'),
      text('infra/kubernetes/base/network-policies.yaml'),
      text('infra/kubernetes/secret-contract.example.yaml'),
      text('infra/kubernetes/base/kustomization.yaml'),
    ])
    expect(deployment).toContain('ALERT_RECEIVER_DATABASE_URL_FILE')
    expect(deployment).toContain('ALERT_RECEIVER_HMAC_SECRET_FILE')
    expect(deployment).toContain('optional: false')
    expect(deployment).toContain('fsGroup: 10001')
    expect(deployment).toContain('fsGroupChangePolicy: OnRootMismatch')
    expect(deployment).toContain('defaultMode: 288')
    expect(deployment).toContain('readOnlyRootFilesystem: true')
    expect(policy).toContain('name: merchant-alert-receiver-boundary')
    expect(policy).toContain('port: 5432')
    expect(contract).toContain('neverTreatReceiptAsHumanAcknowledgement')
    const receiverContract = contract.slice(
      contract.indexOf('name: merchant-alert-receiver-secrets'),
      contract.indexOf('# Scanner credentials'),
    )
    expect(receiverContract).toContain('databaseRole: merchant_alert_receiver')
    expect(receiverContract).not.toContain('databaseRole: merchant_ops')
    expect(kustomization).toContain('- alert-receiver.yaml')
  })

  it('documents a dedicated function-only database credential and fail-closed files', async () => {
    const readme = await text('apps/alert-receiver/README.md')
    expect(readme).toContain('merchant_alert_receiver')
    expect(readme).toContain('has no direct table privileges')
    expect(readme).toContain('public.append_alert_webhook_receipt(text,text,timestamptz,timestamptz,text,jsonb)')
    expect(readme).toContain('public.alert_webhook_receipts_ready()')
    expect(readme).toContain('missing, unreadable, or empty projected file prevents startup')
    expect(readme).not.toMatch(/must use the isolated `merchant_ops` role/u)
  })
})
