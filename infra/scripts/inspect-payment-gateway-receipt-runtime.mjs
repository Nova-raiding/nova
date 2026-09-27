import { spawnSync } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const PROTECTED_ROOT = '/var/lib/merchant-release-security'
const TARGET = '/run/payment-receipts'

function requireValue(ok, message) { if (!ok) throw new Error(message) }

/** Read-only runtime sink check. It does not verify payment or release facts. */
export function inspectPaymentGatewayReceiptRuntime({ inspect, expectedHostDir, expectedContainerId, expectedImageRef,
  expectedProject, protectedRoot = PROTECTED_ROOT, rootUid = 0, gatewayUid = 100 }) {
  requireValue(/^[a-f0-9]{64}$/u.test(expectedContainerId ?? '')
    && /^[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}$/u.test(expectedImageRef ?? '')
    && /^[a-z0-9][a-z0-9_-]{0,62}$/u.test(expectedProject ?? ''),
  'exact container, digest-pinned image and Compose project are required')
  requireValue(isAbsolute(expectedHostDir ?? '') && isAbsolute(protectedRoot)
    && expectedHostDir === resolve(expectedHostDir) && protectedRoot === resolve(protectedRoot)
    && expectedHostDir.startsWith(`${protectedRoot}${sep}`), 'expected receipt directory must be under the protected root')
  requireValue(realpathSync(protectedRoot) === resolve(protectedRoot), 'protected root must be canonical')
  let parent = dirname(expectedHostDir)
  while (parent !== protectedRoot) {
    requireValue(parent.startsWith(`${protectedRoot}${sep}`), 'receipt directory parent escaped the protected root')
    const stat = lstatSync(parent)
    requireValue(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === rootUid && (stat.mode & 0o022) === 0,
      'receipt directory parent ownership or mode is invalid')
    parent = dirname(parent)
  }
  const rootStat = lstatSync(protectedRoot)
  requireValue(rootStat.isDirectory() && !rootStat.isSymbolicLink() && rootStat.uid === rootUid
    && (rootStat.mode & 0o022) === 0, 'protected root ownership or mode is invalid')
  requireValue(realpathSync(expectedHostDir) === resolve(expectedHostDir), 'receipt directory must be canonical')
  const directory = lstatSync(expectedHostDir)
  requireValue(directory.isDirectory() && !directory.isSymbolicLink() && directory.uid === gatewayUid
    && (directory.mode & 0o777) === 0o700, 'gateway receipt directory must be gateway UID mode 0700')
  requireValue(inspect && typeof inspect === 'object' && inspect.Config?.User === '100:101'
    && inspect.State?.Running === true && inspect.State?.Health?.Status === 'healthy',
  'running healthy UID 100:101 payment gateway is required')
  requireValue(inspect.Id === expectedContainerId && /^sha256:[a-f0-9]{64}$/u.test(inspect.Image ?? '')
    && inspect.Config.Image === expectedImageRef
    && inspect.Config.Labels?.['com.docker.compose.project'] === expectedProject
    && inspect.Config.Labels?.['com.docker.compose.service'] === 'payment-gateway',
  'gateway container does not match the frozen Compose service and image')
  requireValue(inspect.HostConfig?.ReadonlyRootfs === true && inspect.HostConfig?.Privileged !== true,
    'gateway root filesystem must be read-only and unprivileged')
  const mounts = inspect.Mounts?.filter(mount => mount.Destination === TARGET) ?? []
  requireValue(mounts.length === 1 && mounts[0].Type === 'bind'
    && mounts[0].Source === expectedHostDir && mounts[0].RW === true,
  'gateway must have exactly one writable protected receipt bind mount')
  return { schema_version: 'payment-gateway-receipt-runtime-review.v1',
    sink_writable_by_gateway_uid: true, review_only: true,
    release_binding_verified: false, provider_and_ledger_reconciled: false,
    final_evidence: false }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [expectedContainerId, expectedHostDir, expectedImageRef, expectedProject] = process.argv.slice(2)
    requireValue(typeof expectedContainerId === 'string' && /^[a-f0-9]{64}$/u.test(expectedContainerId),
      'exact payment gateway container ID is required')
    const result = spawnSync('/usr/bin/docker', ['inspect', '--format', '{{json .}}', expectedContainerId],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
        env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] })
    requireValue(!result.error && result.status === 0, 'payment gateway Docker inspection failed')
    const inspect = JSON.parse(result.stdout)
    const review = inspectPaymentGatewayReceiptRuntime({ inspect, expectedHostDir,
      expectedContainerId, expectedImageRef, expectedProject })
    process.stderr.write('REVIEW_ONLY: receipt sink is writable by gateway UID; candidate identity and provider/ledger facts remain unverified.\n')
    process.stdout.write(`${JSON.stringify(review)}\n`)
  } catch (error) {
    process.stderr.write(`payment gateway receipt runtime review refused: ${error.message}\n`)
    process.exitCode = 1
  }
}
