/**
 * Inventory of `package.json` scripts that no entrypoint invokes.
 *
 * A script nobody calls is indistinguishable from a script that does not
 * exist: the four Alibaba Cloud / object-storage evidence commands had no
 * mention in any document, no runbook and no caller, so the whole evidence
 * chain was invisible. This module makes the inventory explicit and makes it
 * rot-proof: any script that stops being invoked turns the check red until it
 * is either wired into an entrypoint or registered here with a reason.
 *
 * The reachability ledger is an actual invocation scan (`npm run <name>`,
 * `npm run-script <name>` and the `npm test` shorthand) over every tracked
 * text file in the repository, followed through `package.json`'s own scripts.
 * It is deliberately not a bare name search: a comment saying
 * "`npm run invariants:verify` proves this" is documentation, not an
 * entrypoint, and that difference is exactly how a mutation gate with a 23/23
 * headline ended up with no permanent executor.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { filesOnDisk } from './test-entrypoint-coverage.js'

export type UninvokedCategory = 'local-dev' | 'operator-credentials' | 'release-operator'

export interface UninvokedScript {
  script: string
  category: UninvokedCategory
  /** The external authority, environment or human decision it needs. */
  requires: string
  /** Why it must stay out of `check`. */
  reason: string
}

/**
 * The ordered object-storage evidence chain. These four commands are the only
 * path from "credentials exist" to "release evidence exists", and until this
 * list existed nothing in the repository said so in one place. Run them in
 * order from the repository root with real provider credentials in the
 * environment; every one of them fails closed without them, which is why none
 * can sit in `check`.
 *
 *   1. `npm run infra:oss:verify`             read-only: can this identity reach the bucket
 *   2. `npm run test:object-storage-canary`   read/write/delete against a canary prefix
 *   3. `npm run evidence:aliyun-oss-controls` collect the Alibaba Cloud control-plane posture
 *   4. `npm run evidence:object-storage:produce` produce the release evidence bundle
 */
export const UNINVOKED_SCRIPTS: readonly UninvokedScript[] = [
  {
    script: 'test:kubernetes-release-gate',
    category: 'release-operator',
    requires: 'An explicitly requested Kubernetes or ACK release review',
    reason: 'Kubernetes and ACK are outside the current ECS release scope. This dedicated suite remains runnable when that deployment target is explicitly authorized, while the ECS release gate does not invoke it.',
  },
  {
    script: 'dev:stack:relay',
    category: 'local-dev',
    requires: 'A local Docker daemon and a relay credential in the developer environment',
    reason: 'Developer convenience wrapper around scripts/start-local-with-relay.sh for a live-model local stack. Requires a real model credential, so it cannot be part of a hermetic check.',
  },
  {
    script: 'dev:stack:demo',
    category: 'local-dev',
    requires: 'A local Docker daemon',
    reason: 'Developer convenience wrapper around scripts/start-local-demo.sh; starts a long-running stack rather than asserting anything.',
  },
  {
    script: 'dev:stack:relay:build',
    category: 'local-dev',
    requires: 'A local Docker daemon and a relay credential',
    reason: 'Same stack as dev:stack:relay plus an explicit image rebuild of api/api-replica/ui/worker-generation. Operator-triggered, non-terminating.',
  },
  {
    script: 'infra:oss:verify',
    category: 'operator-credentials',
    requires: 'Real Alibaba Cloud OSS credentials with access to the release bucket',
    reason: 'Read-only credential probe (infra/scripts/verify-oss-access.mjs). Without real provider credentials it cannot pass, and with them it touches an external account, so it is step 1 of the object-storage evidence chain above rather than a check step.',
  },
  {
    script: 'test:object-storage-canary',
    category: 'operator-credentials',
    requires: 'Real Alibaba Cloud OSS credentials with write and delete rights on a canary prefix',
    reason: 'Writes and deletes objects in a real bucket. Step 2 of the object-storage evidence chain; a hermetic run would have to fake the provider, which is the one thing this canary exists to prevent.',
  },
  {
    script: 'evidence:aliyun-oss-controls',
    category: 'operator-credentials',
    requires: 'Real Alibaba Cloud credentials plus the Alibaba Cloud CLI',
    reason: 'Collects the external control-plane posture (RAM, bucket policy, versioning, logging) as release evidence. Step 3 of the object-storage evidence chain; see docs/runbooks/aliyun-oss-canary-delete-version-authorization.md.',
  },
  {
    script: 'evidence:object-storage:produce',
    category: 'operator-credentials',
    requires: 'Real Alibaba Cloud OSS credentials and the raw outputs of steps 1-3',
    reason: 'Produces the signed object-storage evidence bundle. Step 4 of the object-storage evidence chain; it consumes operator-collected raw evidence, so nothing in the repository can synthesise its input.',
  },
  {
    script: 'release:bump',
    category: 'release-operator',
    requires: 'A human release decision',
    reason: 'Mutates VERSION and the release metadata with --apply. It is a deliberate release action, not a gate; running it inside check would rewrite the tree on every test run.',
  },
  {
    script: 'verify:commercial-read-boundaries',
    category: 'release-operator',
    requires: 'A host with Docker that can start the isolated PostgreSQL 17 / Redis fixture, plus a free loopback port for the real API process',
    reason: 'Fail-closed acceptance for the commercial payment read path: the creator-only PostgreSQL reader, row-level security, the HTTP route and the native MCP tool must each deny every non-creator read and disclose no checkout URL. It is registered rather than wired because it starts a real API process against an isolated PostgreSQL 17 fixture and takes minutes — folding it into `check` would change the delivery gate runtime, and that promotion is a separate decision. The runner provisions its own fixture and reads no database URL and no .env, so `npm run verify:commercial-read-boundaries` is the whole setup.',
  },
]

const TEXT_FILE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx|json|ya?ml|md|sh|bash)$/u

/**
 * Which files may count as an entrypoint for a script.
 *
 *   - **Executors**: workflows, launchers, infrastructure scripts. They invoke
 *     the command for real.
 *   - **Runbooks**: `doc/**`, `docs/**` and top-level markdown. A step that
 *     needs real credentials or a human decision is entered by an operator
 *     reading a runbook, so the documented command *is* its entrypoint — the
 *     defect this inventory exists to prevent is a script nobody knows about.
 *
 * Deliberately excluded: `tests/**` and this module's own source. A test that
 * asserts on a script's text, or an inventory that lists a script as
 * uninvoked, is not a caller — counting those would let the ledger certify
 * itself, which is the same always-true mistake the string-matching check
 * made.
 */
function isEntrypointSource(file: string): boolean {
  return file.startsWith('.github/') || file.startsWith('scripts/') || file.startsWith('infra/')
    || file.endsWith('.sh') || file.endsWith('.bash')
    || file.startsWith('doc/') || file.startsWith('docs/') || !file.includes('/')
}

/** `npm run foo`, `npm run-script foo` and the `npm test` shorthand. */
function invocationsIn(source: string): string[] {
  const names: string[] = []
  for (const match of source.matchAll(/npm\s+(?:run|run-script)\s+([A-Za-z0-9:_-]+)|npm\s+(test|start)\b/gu)) {
    names.push(match[1] ?? match[2]!)
  }
  return names
}

/**
 * Scripts some other script, workflow, document or tooling file actually
 * invokes, followed through `package.json` so `check` → `npm test` → the
 * launcher counts as one chain.
 */
export function invokedScriptNames(root: string): Set<string> {
  const scripts = (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
  const invoked = new Set<string>()
  for (const file of filesOnDisk(root, name => TEXT_FILE.test(name))) {
    if (file === 'package.json' || !isEntrypointSource(file)) continue
    for (const name of invocationsIn(readFileSync(resolve(root, file), 'utf8'))) invoked.add(name)
  }
  let changed = true
  while (changed) {
    changed = false
    for (const name of [...invoked]) {
      for (const nested of invocationsIn(scripts[name] ?? '')) {
        if (!invoked.has(nested)) { invoked.add(nested); changed = true }
      }
    }
  }
  return invoked
}

/** Scripts in `package.json` that nothing invokes. */
export function uninvokedScriptNames(root: string): string[] {
  const scripts = Object.keys((JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts)
  const invoked = invokedScriptNames(root)
  return scripts.filter(name => !invoked.has(name)).sort()
}
