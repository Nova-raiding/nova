#!/usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node
// Review-only source collector. It never signs or emits final release evidence.
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs'
import { join, parse, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const INSTALLED_PATH = '/usr/local/libexec/merchant/capture-canonical-safe-state'
const PSQL = '/usr/pgsql-16/bin/psql'
const TRUST_ROOT = '/run/release-security/evidence-trust'
const INSTALLED_DIGEST = join(TRUST_ROOT, 'canonical-safe-state-collector-sha256')
const BINDING_FIELDS = ['release_id', 'release_git_sha', 'candidate_manifest_sha256', 'release_manifest_sha256', 'image_set_digest', 'deployment_nonce_sha256']
const HEX = /^[a-f0-9]{64}$/u
const GIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const ID = /^[A-Za-z0-9._:-]{1,128}$/u
const NONCE = /^[A-Za-z0-9_-]{22,128}$/u
const sha256 = value => createHash('sha256').update(value).digest('hex')

function assert(value, message) { if (!value) throw new Error(message) }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}

function assertProtectedPath(path, { kind } = {}) {
  assert(path === resolve(path) && realpathSync(path) === path, 'protected path must be canonical and absolute')
  const { root } = parse(path); let current = root
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    const stat = lstatSync(current)
    assert(!stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0, `untrusted protected path component: ${current}`)
  }
  const stat = lstatSync(path)
  if (kind === 'file') assert(stat.isFile(), 'protected path must be a regular file')
  if (kind === 'directory') assert(stat.isDirectory(), 'protected path must be a directory')
  return stat
}

function readProtected(path, maxBytes = 65_536) {
  assertProtectedPath(path, { kind: 'file' })
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    assert(stat.uid === 0 && (stat.mode & 0o777) === 0o600 && stat.size > 0 && stat.size <= maxBytes, 'protected input must be root-owned mode 0600 and within size limit')
    const bytes = readFileSync(fd)
    assert(bytes.length === stat.size, 'protected input changed while being read')
    return bytes
  } finally { closeSync(fd) }
}

function readInstalledExecutable(path, maxBytes) {
  assertProtectedPath(path, { kind: 'file' })
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    assert(stat.uid === 0 && (stat.mode & 0o022) === 0 && stat.size > 0 && stat.size <= maxBytes, 'installed executable must be root-owned, protected and within size limit')
    const bytes = readFileSync(fd)
    assert(bytes.length === stat.size, 'installed executable changed while being read')
    return bytes
  } finally { closeSync(fd) }
}

function assertInstalledIdentity() {
  assert(process.getuid?.() === 0 && process.geteuid?.() === 0, 'collector must run as root')
  assert(realpathSync(process.argv[1]) === INSTALLED_PATH, 'collector must run from its fixed installed path')
  for (const path of [INSTALLED_PATH, PSQL, process.execPath, INSTALLED_DIGEST]) assertProtectedPath(path, { kind: 'file' })
  const expected = readProtected(INSTALLED_DIGEST, 128).toString('utf8').trim()
  assert(HEX.test(expected) && sha256(readInstalledExecutable(INSTALLED_PATH, 2 * 1024 * 1024)) === expected, 'installed collector digest mismatch')
}

export function validateCandidateBinding(environment) {
  const value = {
    release_id: environment.RELEASE_ID,
    release_git_sha: environment.RELEASE_GIT_SHA,
    candidate_manifest_sha256: environment.MANIFEST_SHA256,
    release_manifest_sha256: environment.RELEASE_MANIFEST_SHA256,
    image_set_digest: environment.IMAGE_SET_DIGEST,
    deployment_nonce_sha256: typeof environment.DEPLOYMENT_NONCE === 'string' ? sha256(environment.DEPLOYMENT_NONCE) : '',
  }
  assert(ID.test(value.release_id ?? '') && GIT.test(value.release_git_sha ?? ''), 'candidate release identity is incomplete')
  for (const field of ['candidate_manifest_sha256', 'release_manifest_sha256']) assert(HEX.test(value[field] ?? ''), `${field} is invalid`)
  assert(/^sha256:[a-f0-9]{64}$/u.test(value.image_set_digest ?? ''), 'image_set_digest is invalid')
  assert(NONCE.test(environment.DEPLOYMENT_NONCE ?? ''), 'deployment nonce is invalid')
  return value
}

const bucket = (flagKey, environment, subject) => {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(`${flagKey}\0${environment}\0${subject}`)) {
    hash ^= byte; hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % 10000
}

/** Mirrors the production feature-flag evaluator for a workspace-only read. */
export function resolveCanonicalSafeState(flag, targets, workspaceId, at) {
  if (!flag) return 'legacy_shadow'
  if (flag.emergency_disabled || !flag.enabled) return 'legacy_shadow'
  const now = Date.parse(at)
  if (!Number.isFinite(now) || (flag.valid_from && now < Date.parse(flag.valid_from)) || (flag.valid_to && now >= Date.parse(flag.valid_to))) return 'legacy_shadow'
  const exact = targets.find(target => target.target_type === 'workspace' && target.target_value === workspaceId)
  const matched = exact ?? targets.filter(target => target.target_type === 'percentage' && Number(target.target_value) > bucket(flag.flag_key, flag.environment, workspaceId)).sort((a, b) => Number(a.target_value) - Number(b.target_value))[0]
  if (matched) {
    if (!matched.enabled) return 'legacy_shadow'
    const value = matched.value_json ?? flag.value_json
    return typeof value === 'string' && ['legacy_shadow', 'dual_verify', 'canonical_read'].includes(value) ? value : 'legacy_shadow'
  }
  return typeof flag.value_json === 'string' && ['legacy_shadow', 'dual_verify', 'canonical_read'].includes(flag.value_json) ? flag.value_json : 'legacy_shadow'
}

const GUARD_SQL = String.raw`
WITH reader AS (
  SELECT oid, rolname, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
         rolbypassrls, rolreplication, rolcanlogin, rolconnlimit
  FROM pg_roles WHERE rolname = current_user
), source_tables AS (
  SELECT unnest(ARRAY['public.workspaces','public.platform_feature_flags','public.platform_feature_flag_targets']) AS relation_name
), source_acl AS (
  SELECT count(*) = 3 AS all_tables_exist,
         bool_and(has_table_privilege(current_user, relation_name, 'SELECT')) AS all_select,
         bool_and(NOT has_table_privilege(current_user, relation_name,
           'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
           AND bool_and(NOT has_any_column_privilege(current_user, relation_name,
             'INSERT,UPDATE,REFERENCES')) AS no_table_or_column_writes,
         bool_and((SELECT c.relowner <> (SELECT oid FROM reader)
                   FROM pg_class c WHERE c.oid = to_regclass(relation_name))) AS no_owned_tables
  FROM source_tables
), membership AS (
  SELECT count(*) = 0 AS no_memberships
  FROM pg_auth_members m, reader r
  WHERE m.member = r.oid OR m.roleid = r.oid
), workspace_policy AS (
  SELECT c.relrowsecurity AND c.relforcerowsecurity AS forced_rls,
         (SELECT count(*) = 1 AND bool_and(p.polcmd = 'r' AND p.polpermissive
           AND p.polroles = ARRAY[(SELECT oid FROM reader)]::oid[]
           AND pg_get_expr(p.polqual, p.polrelid) = '(CURRENT_USER = ''canonical_safe_state_reader''::name)')
          FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'workspaces_canonical_safe_state_reader') AS exact_reader_policy,
         NOT EXISTS (SELECT 1 FROM pg_policy p, reader r
           WHERE p.polrelid = c.oid AND NOT p.polpermissive AND p.polcmd IN ('r','*')
             AND (0::oid = ANY(p.polroles) OR r.oid = ANY(p.polroles))) AS no_restrictive_reader_policy
  FROM pg_class c WHERE c.oid = 'public.workspaces'::regclass
), schema_acl AS (
  SELECT has_database_privilege(current_user, current_database(), 'CONNECT') AS can_connect,
         NOT has_database_privilege(current_user, current_database(), 'CREATE,TEMPORARY') AS no_database_create_or_temp,
         has_schema_privilege(current_user, 'public', 'USAGE') AS can_use_public,
         NOT has_schema_privilege(current_user, 'public', 'CREATE') AS no_public_create,
         NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname <> 'public'
           AND n.nspname <> 'information_schema' AND left(n.nspname, 3) <> 'pg_'
           AND has_schema_privilege(current_user, n.oid, 'USAGE,CREATE')) AS no_other_schema_access
), other_relations AS (
  SELECT NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname <> 'information_schema' AND left(n.nspname, 3) <> 'pg_'
        AND c.relkind IN ('r','p','v','m','f')
        AND c.oid NOT IN ('public.workspaces'::regclass,'public.platform_feature_flags'::regclass,'public.platform_feature_flag_targets'::regclass)
        AND (has_table_privilege(current_user, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR has_any_column_privilege(current_user, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))) AS no_other_relation_access,
         NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname <> 'information_schema' AND left(n.nspname, 3) <> 'pg_'
        AND c.relkind = 'S' AND has_sequence_privilege(current_user, c.oid, 'USAGE,SELECT,UPDATE')) AS no_sequence_access
), other_capabilities AS (
  SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname <> 'information_schema' AND left(n.nspname, 3) <> 'pg_'
        AND p.prosecdef AND p.prorettype <> 'pg_catalog.trigger'::regtype
        AND has_function_privilege(current_user, p.oid, 'EXECUTE')) AS no_security_definer_execution,
         NOT EXISTS (SELECT 1 FROM pg_class c, reader r WHERE c.relowner = r.oid)
           AND NOT EXISTS (SELECT 1 FROM pg_proc p, reader r WHERE p.proowner = r.oid)
           AND NOT EXISTS (SELECT 1 FROM pg_namespace n, reader r WHERE n.nspowner = r.oid)
           AND NOT EXISTS (SELECT 1 FROM pg_database d, reader r WHERE d.datdba = r.oid)
           AND NOT EXISTS (SELECT 1 FROM pg_type t, reader r WHERE t.typowner = r.oid) AS no_owned_objects,
         NOT EXISTS (SELECT 1 FROM pg_database d WHERE d.datname <> current_database() AND d.datallowconn
           AND has_database_privilege(current_user, d.oid, 'CONNECT,CREATE,TEMPORARY')) AS no_other_database_access
), source_rls AS (
  SELECT bool_and(NOT c.relrowsecurity) AS flags_unfiltered
  FROM pg_class c WHERE c.oid IN ('public.platform_feature_flags'::regclass,'public.platform_feature_flag_targets'::regclass)
), read_probe AS MATERIALIZED (
  SELECT (SELECT count(*) FROM (SELECT 1 FROM public.workspaces LIMIT 1) AS w)
       + (SELECT count(*) FROM (SELECT 1 FROM public.platform_feature_flags LIMIT 1) AS f)
       + (SELECT count(*) FROM (SELECT 1 FROM public.platform_feature_flag_targets LIMIT 1) AS t) AS readable_rows
)
SELECT CASE WHEN
  current_user = 'canonical_safe_state_reader'
  AND session_user = 'canonical_safe_state_reader'
  AND current_setting('transaction_read_only') = 'on'
  AND current_setting('row_security') = 'on'
  AND EXISTS (SELECT 1 FROM reader WHERE NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolinherit AND NOT rolbypassrls
      AND NOT rolreplication AND rolcanlogin AND rolconnlimit = 2)
  AND (SELECT all_tables_exist AND all_select AND no_table_or_column_writes AND no_owned_tables FROM source_acl)
  AND (SELECT no_memberships FROM membership)
  AND (SELECT forced_rls AND exact_reader_policy AND no_restrictive_reader_policy FROM workspace_policy)
  AND (SELECT can_connect AND no_database_create_or_temp AND can_use_public
      AND no_public_create AND no_other_schema_access FROM schema_acl)
  AND (SELECT no_other_relation_access AND no_sequence_access FROM other_relations)
  AND (SELECT no_security_definer_execution AND no_owned_objects AND no_other_database_access FROM other_capabilities)
  AND (SELECT flags_unfiltered FROM source_rls)
  AND (SELECT readable_rows BETWEEN 0 AND 3 FROM read_probe)
THEN true ELSE false END AS guard_ok
\gset
\if :guard_ok
\else
SELECT 1 / 0 AS canonical_safe_state_role_guard_failed;
\endif
`

export const CAPTURE_SQL = `${GUARD_SQL}${String.raw`
SELECT jsonb_build_object(
  'observed_at', to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'database_name', current_database(),
  'database_oid', (SELECT oid::text FROM pg_database WHERE datname = current_database()),
  'workspaces', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'status', status) ORDER BY id) FROM public.workspaces), '[]'::jsonb),
  'flags', COALESCE((SELECT jsonb_agg(jsonb_build_object('flag_key', flag_key, 'environment', environment, 'value_type', value_type, 'value_json', value_json, 'enabled', enabled, 'emergency_disabled', emergency_disabled, 'valid_from', valid_from, 'valid_to', valid_to, 'revision', revision) ORDER BY id) FROM public.platform_feature_flags WHERE flag_key = 'canonical.product.read_mode' AND environment = 'production'), '[]'::jsonb),
  'targets', COALESCE((SELECT jsonb_agg(jsonb_build_object('target_type', t.target_type, 'target_value', t.target_value, 'enabled', t.enabled, 'value_json', t.value_json) ORDER BY t.target_type, t.target_value, t.id) FROM public.platform_feature_flag_targets t JOIN public.platform_feature_flags f ON f.id = t.flag_id WHERE f.flag_key = 'canonical.product.read_mode' AND f.environment = 'production'), '[]'::jsonb)
)::text;
COMMIT;
`}`

export function summarizeCanonicalSafeState(snapshot) {
  assert(snapshot && typeof snapshot === 'object' && Array.isArray(snapshot.workspaces) && Array.isArray(snapshot.flags) && Array.isArray(snapshot.targets), 'database snapshot shape is invalid')
  const observedAt = snapshot.observed_at
  assert(typeof observedAt === 'string' && Number.isFinite(Date.parse(observedAt)), 'database snapshot timestamp is invalid')
  assert(snapshot.workspaces.length > 0 && snapshot.workspaces.some(workspace => workspace.status === 'active'), 'database snapshot has no active workspace')
  assert(snapshot.flags.length <= 1, 'canonical read-mode flag is duplicated')
  const flag = snapshot.flags[0]
  if (flag) assert(flag.flag_key === 'canonical.product.read_mode' && flag.environment === 'production' && flag.value_type === 'string' && typeof flag.enabled === 'boolean' && typeof flag.emergency_disabled === 'boolean', 'canonical read-mode flag shape is invalid')
  const modes = snapshot.workspaces.map(workspace => {
    assert(typeof workspace.id === 'string' && workspace.id.length > 0 && ['active', 'disabled'].includes(workspace.status), 'workspace row is invalid')
    return { workspace_id_sha256: sha256(workspace.id), status: workspace.status, mode: resolveCanonicalSafeState(flag, snapshot.targets, workspace.id, observedAt) }
  })
  const counts = Object.fromEntries(['legacy_shadow', 'dual_verify', 'canonical_read'].map(mode => [mode, modes.filter(item => item.mode === mode).length]))
  const blockers = []
  if (counts.dual_verify || counts.canonical_read) blockers.push('one or more workspaces are not in legacy_shadow')
  if (typeof snapshot.database_name !== 'string' || !snapshot.database_name || !/^\d+$/u.test(snapshot.database_oid ?? '')) blockers.push('database identity is incomplete')
  return {
    observed_at: observedAt,
    source: 'production_postgres_read_only_role_claim',
    database_name_sha256: typeof snapshot.database_name === 'string' ? sha256(snapshot.database_name) : null,
    database_oid: snapshot.database_oid ?? null,
    workspace_count: modes.length,
    active_workspace_count: modes.filter(item => item.status === 'active').length,
    workspace_id_set_sha256: sha256(canonical(modes.map(item => item.workspace_id_sha256).sort())),
    mode_counts: counts,
    blockers,
  }
}

function validateServiceFile() {
  const service = process.env.CANONICAL_SAFE_STATE_PGSERVICE ?? ''
  const path = process.env.PGSERVICEFILE ?? ''
  assert(/^[A-Za-z0-9._-]{1,64}$/u.test(service), 'canonical safe-state psql service name is invalid')
  assert(path.startsWith('/') && path === resolve(path) && realpathSync(path) === path, 'libpq service file must be canonical and absolute')
  const bytes = readProtected(path, 65_536)
  return { service, sha256: sha256(bytes) }
}

function writeReviewArtifact(document) {
  const root = '/var/lib/merchant-release-security/canonical-safe-state'
  assertProtectedPath(root, { kind: 'directory' })
  const file = join(root, `${document.candidate_binding.release_id}-${randomUUID()}.json`)
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`)
    let offset = 0
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
    fsyncSync(fd)
  } finally { closeSync(fd) }
  const dir = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(dir) } finally { closeSync(dir) }
  return file
}

function main() {
  assertInstalledIdentity()
  const binding = validateCandidateBinding(process.env)
  const service = validateServiceFile()
  const result = spawnSync(PSQL, [`service=${process.env.CANONICAL_SAFE_STATE_PGSERVICE}`, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], {
    input: `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n${CAPTURE_SQL}`,
    encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 30_000,
    env: { PATH: '/usr/bin:/bin', PGSERVICEFILE: process.env.PGSERVICEFILE, LANG: 'C', LC_ALL: 'C' },
  })
  assert(!result.error && result.status === 0, 'read-only snapshot refused or source role verification failed')
  const rows = result.stdout.trim().split(/\n/u).filter(Boolean)
  assert(rows.length === 1, 'database snapshot output was not exactly one JSON row')
  const snapshot = JSON.parse(rows[0])
  const summary = summarizeCanonicalSafeState(snapshot)
  const blockers = [...summary.blockers,
    'candidate identity is operator-supplied and has not been independently verified',
    'cluster system identifier is not available to the SELECT-only reader',
    'collector signing key and protected installation receipt are not provisioned',
  ]
  const document = {
    schema_version: 'canonical-safe-state-review/1',
    status: 'REVIEW_ONLY',
    final_evidence: false,
    source_provenance_verified: false,
    candidate_binding_verified: false,
    candidate_binding: binding,
    source_service_file_sha256: service.sha256,
    ...summary,
    blockers,
  }
  const path = writeReviewArtifact(document)
  process.stdout.write(`${path}\n`)
  process.stderr.write('REVIEW_ONLY: state snapshot is unsigned and not independently bound to a production cluster or candidate; it cannot satisfy release gates.\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main() } catch (error) { process.stderr.write(`canonical safe-state snapshot refused: ${error.message}\n`); process.exitCode = 1 }
}
