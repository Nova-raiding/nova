import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installStagingToolchain, rollbackStagingToolchain } from '../infra/scripts/install-ecs-staging-toolchain.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const stagePath = 'infra/scripts/stage-verified-ecs-release.sh';
const lockPath = 'infra/scripts/ecs-build-lock.sh';

function candidate(root, label) {
  const repo = join(root, `repo-${label}`);
  mkdirSync(join(repo, 'infra/scripts'), { recursive: true });
  writeFileSync(join(repo, stagePath), `#!/bin/sh\nset -eu\nroot=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)\n[ -f "$root/${lockPath}" ] || exit 91\nprintf '%s\\n' '${label}'\n`);
  writeFileSync(join(repo, lockPath), `#!/bin/sh\n# shared lock ${label}\n`);
  chmodSync(join(repo, stagePath), 0o755);
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', label]);
  const gitSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const archive = join(root, `candidate-${label}.tar`);
  const bytes = execFileSync('git', ['-C', repo, 'archive', '--format=tar', 'HEAD']);
  writeFileSync(archive, bytes, { mode: 0o600 });
  const identity = join(root, `identity-${label}.txt`);
  writeFileSync(identity, [
    `git_sha=${gitSha}`,
    `source_sha256=sha256:${sha(bytes)}`,
    `comparison_manifest_sha256=sha256:${'1'.repeat(64)}`,
    `sync_plan_sha256=sha256:${'2'.repeat(64)}`,
    '',
  ].join('\n'), { mode: 0o600 });
  return { archivePath: archive, identityPath: identity, gitSha };
}

test('installs both helpers from the identity-bound archive and atomically switches generations', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ecs-staging-toolchain-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  chmodSync(root, 0o700);
  const controlRoot = join(root, 'controls');
  mkdirSync(controlRoot, { mode: 0o700 });
  const first = candidate(root, 'first');
  const firstReceipt = await installStagingToolchain({ ...first, controlRoot });
  assert.equal(firstReceipt.git_sha, first.gitSha);
  assert.equal(firstReceipt.previous_git_sha, null);
  const stagingEnv = { ...process.env, ECS_CANDIDATE_BUNDLE_DIR: '/candidate', ECS_RELEASES_ROOT: '/releases', RELEASE_ID: 'test' };
  assert.equal(execFileSync('/bin/sh', [join(controlRoot, 'stage-verified-ecs-release.sh')], { encoding: 'utf8', env: stagingEnv }).trim(), 'first');
  const firstTarget = readFileSync(join(controlRoot, 'staging-toolchain/current/infra/scripts/ecs-build-lock.sh'), 'utf8');
  assert.match(firstTarget, /shared lock first/);

  const second = candidate(root, 'second');
  const secondReceipt = await installStagingToolchain({ ...second, controlRoot });
  assert.equal(secondReceipt.previous_git_sha, first.gitSha);
  assert.equal(execFileSync('/bin/sh', [join(controlRoot, 'stage-verified-ecs-release.sh')], { encoding: 'utf8', env: stagingEnv }).trim(), 'second');
  assert.match(readFileSync(join(controlRoot, 'staging-toolchain/current/infra/scripts/ecs-build-lock.sh'), 'utf8'), /shared lock second/);

  const rollback = rollbackStagingToolchain({ controlRoot });
  assert.equal(rollback.from_git_sha, second.gitSha);
  assert.equal(rollback.to_git_sha, first.gitSha);
  assert.equal(execFileSync('/bin/sh', [join(controlRoot, 'stage-verified-ecs-release.sh')], { encoding: 'utf8', env: stagingEnv }).trim(), 'first');
});

test('rejects archive identity mismatch without switching the active pair', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ecs-staging-toolchain-reject-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  chmodSync(root, 0o700);
  const controlRoot = join(root, 'controls');
  mkdirSync(controlRoot, { mode: 0o700 });
  const item = candidate(root, 'valid');
  await installStagingToolchain({ ...item, controlRoot });
  const invalid = candidate(root, 'tampered');
  writeFileSync(invalid.identityPath, readFileSync(invalid.identityPath, 'utf8').replace(/source_sha256=sha256:[a-f0-9]{64}/, `source_sha256=sha256:${'0'.repeat(64)}`), { mode: 0o600 });
  await assert.rejects(installStagingToolchain({ ...invalid, controlRoot }), /candidate archive checksum/);
  assert.equal(execFileSync('/bin/sh', [join(controlRoot, 'stage-verified-ecs-release.sh')], { encoding: 'utf8', env: { ...process.env, ECS_CANDIDATE_BUNDLE_DIR: '/candidate', ECS_RELEASES_ROOT: '/releases', RELEASE_ID: 'test' } }).trim(), 'valid');
});
